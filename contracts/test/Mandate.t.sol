// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Mandate} from "../src/Mandate.sol";

/// 6-decimal test token with the standard bool-returning transferFrom.
contract TestUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MandateTest is Test {
    Mandate mandate;
    TestUSDC usdc;

    address customer = makeAddr("customer");
    address agent = makeAddr("agent");
    address issuer = makeAddr("issuer"); // allowlisted recipient
    address stranger = makeAddr("stranger");
    address dShare = makeAddr("dShare"); // an allowlisted asset the agent may buy
    address otherAsset = makeAddr("otherAsset");

    uint256 constant USDC = 1e6;
    uint256 constant PER_ORDER = 50 * USDC;
    uint256 constant DAILY = 120 * USDC;

    function setUp() public {
        vm.warp(1_800_000_000);
        mandate = new Mandate();
        usdc = new TestUSDC();
        usdc.mint(customer, 1_000 * USDC);
        vm.prank(customer);
        usdc.approve(address(mandate), type(uint256).max);
        _set(Mandate.Mode.Autopilot);
    }

    function _set(Mandate.Mode mode) internal returns (uint64 version) {
        address[] memory assets = new address[](2);
        assets[0] = address(usdc);
        assets[1] = dShare;
        address[] memory recipients = new address[](1);
        recipients[0] = issuer;
        vm.prank(customer);
        version = mandate.setMandate(
            agent, address(usdc), mode, PER_ORDER, DAILY, uint64(block.timestamp + 30 days), assets, recipients
        );
    }

    function _exec(bytes32 id, address asset, address recipient, uint256 amount)
        internal
        returns (bool ok, Mandate.Reason reason)
    {
        vm.prank(agent);
        (ok, reason) = mandate.execute(customer, id, asset, recipient, amount);
    }

    // ------------------------------------------------------------ in-policy

    function test_inPolicyTransferMovesFundsCustomerToRecipient() public {
        vm.expectEmit(true, true, true, true);
        emit Mandate.ProposalExecuted(customer, "p1", 1, agent, dShare, issuer, 40 * USDC);
        (bool ok, Mandate.Reason reason) = _exec("p1", dShare, issuer, 40 * USDC);

        assertTrue(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.None));
        assertEq(usdc.balanceOf(issuer), 40 * USDC);
        assertEq(usdc.balanceOf(customer), 960 * USDC);
        assertEq(usdc.balanceOf(address(mandate)), 0, "the contract never holds funds");
        assertEq(usdc.balanceOf(agent), 0, "the agent never holds funds");
        assertEq(uint8(mandate.proposalStatus(customer, "p1")), uint8(Mandate.Status.Executed));
        assertEq(mandate.spentInWindow(customer), 40 * USDC);
    }

    function test_orderExactlyAtPerOrderCapExecutes() public {
        (bool ok,) = _exec("p1", dShare, issuer, PER_ORDER);
        assertTrue(ok);
    }

    // ----------------------------------------------------------- cap breach

    function test_overPerOrderCapIsRejectedAndRecordedNotReverted() public {
        vm.expectEmit(true, true, true, true);
        emit Mandate.ProposalRejected(
            customer, "big", 1, agent, dShare, issuer, PER_ORDER + 1, Mandate.Reason.OverPerOrderCap
        );
        (bool ok, Mandate.Reason reason) = _exec("big", dShare, issuer, PER_ORDER + 1);

        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.OverPerOrderCap));
        assertEq(usdc.balanceOf(issuer), 0, "nothing moved");
        assertEq(usdc.balanceOf(customer), 1_000 * USDC);
        assertEq(mandate.spentInWindow(customer), 0, "a rejection does not count as spend");
        assertEq(uint8(mandate.proposalStatus(customer, "big")), uint8(Mandate.Status.Rejected));
    }

    function test_rollingDailyCapBlocksTheOrderThatWouldExceedIt() public {
        (bool a,) = _exec("a", dShare, issuer, 50 * USDC);
        (bool b,) = _exec("b", dShare, issuer, 50 * USDC);
        assertTrue(a && b);

        // 100 spent; 21 more would make 121 > 120.
        (bool c, Mandate.Reason reason) = _exec("c", dShare, issuer, 21 * USDC);
        assertFalse(c);
        assertEq(uint8(reason), uint8(Mandate.Reason.OverDailyCap));

        // Exactly up to the cap is fine.
        (bool d,) = _exec("d", dShare, issuer, 20 * USDC);
        assertTrue(d);
        assertEq(usdc.balanceOf(issuer), 120 * USDC);
    }

    function test_dailyCapIsRollingNotCalendar() public {
        _exec("a", dShare, issuer, 50 * USDC);
        vm.warp(block.timestamp + 12 hours);
        _exec("b", dShare, issuer, 50 * USDC);

        // 23 hours after the first spend: both still count.
        vm.warp(block.timestamp + 11 hours);
        (bool c, Mandate.Reason reason) = _exec("c", dShare, issuer, 30 * USDC);
        assertFalse(c);
        assertEq(uint8(reason), uint8(Mandate.Reason.OverDailyCap));

        // 26 hours after the first spend it has left the window; the second has not.
        vm.warp(block.timestamp + 3 hours);
        assertEq(mandate.spentInWindow(customer), 50 * USDC);
        (bool d,) = _exec("d", dShare, issuer, 30 * USDC);
        assertTrue(d);
    }

    function testFuzz_neverMoreThanDailyCapInAny24Hours(uint8[24] memory gaps, uint64[24] memory amounts) public {
        uint256[] memory times = new uint256[](24);
        uint256[] memory moved = new uint256[](24);
        for (uint256 i = 0; i < 24; i++) {
            vm.warp(block.timestamp + uint256(gaps[i]) * 10 minutes);
            uint256 amount = bound(uint256(amounts[i]), 1, PER_ORDER);
            (bool ok,) = _exec(bytes32(i + 1), dShare, issuer, amount);
            times[i] = block.timestamp;
            moved[i] = ok ? amount : 0;
        }
        // For every executed order, the total moved in the 24 hours ending at it is within the cap.
        for (uint256 i = 0; i < 24; i++) {
            uint256 total;
            for (uint256 j = 0; j <= i; j++) {
                if (times[i] - times[j] < 24 hours) total += moved[j];
            }
            assertLe(total, DAILY);
        }
    }

    // ----------------------------------------------------------- allowlists

    function test_recipientOutsideAllowlistIsRejected() public {
        (bool ok, Mandate.Reason reason) = _exec("p", dShare, stranger, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.RecipientNotAllowed));
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_agentCannotPayItself() public {
        (bool ok, Mandate.Reason reason) = _exec("p", address(usdc), agent, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.RecipientNotAllowed));
    }

    function test_assetOutsideAllowlistIsRejected() public {
        (bool ok, Mandate.Reason reason) = _exec("p", otherAsset, issuer, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.AssetNotAllowed));
    }

    // ------------------------------------------------------ expiry / revoke

    function test_expiredMandateRejects() public {
        vm.warp(block.timestamp + 30 days);
        (bool ok, Mandate.Reason reason) = _exec("p", dShare, issuer, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.Expired));
    }

    function test_revokedMandateRejectsUntilANewOneIsSet() public {
        vm.prank(customer);
        mandate.revoke();
        (bool ok, Mandate.Reason reason) = _exec("p1", dShare, issuer, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.Revoked));

        assertEq(_set(Mandate.Mode.Autopilot), 2);
        (bool ok2,) = _exec("p2", dShare, issuer, 10 * USDC);
        assertTrue(ok2);
    }

    function test_newVersionStartsWithFreshAllowlistsButKeepsSpend() public {
        _exec("a", dShare, issuer, 50 * USDC);

        address[] memory assets = new address[](1);
        assets[0] = address(usdc);
        address[] memory recipients = new address[](1);
        recipients[0] = stranger;
        vm.prank(customer);
        mandate.setMandate(
            agent, address(usdc), Mandate.Mode.Autopilot, PER_ORDER, DAILY, uint64(block.timestamp + 1 days), assets, recipients
        );

        (, Mandate.Reason r1) = _exec("b", dShare, stranger, 10 * USDC);
        assertEq(uint8(r1), uint8(Mandate.Reason.AssetNotAllowed), "old asset allowlist is gone");
        (, Mandate.Reason r2) = _exec("c", address(usdc), issuer, 10 * USDC);
        assertEq(uint8(r2), uint8(Mandate.Reason.RecipientNotAllowed), "old recipient allowlist is gone");
        assertEq(mandate.spentInWindow(customer), 50 * USDC, "resetting the mandate does not reset the window");
    }

    // -------------------------------------------------------------- Copilot

    function test_copilotRequiresTheCustomersApprovalOfTheExactProposal() public {
        _set(Mandate.Mode.Copilot);

        (bool ok, Mandate.Reason reason) = _exec("p1", dShare, issuer, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.NotApproved));

        vm.prank(customer);
        mandate.approve("p2", dShare, issuer, 10 * USDC);

        // Same id, different amount: not what was approved.
        (bool changed, Mandate.Reason r2) = _exec("p2", dShare, issuer, 11 * USDC);
        assertFalse(changed);
        assertEq(uint8(r2), uint8(Mandate.Reason.NotApproved));

        vm.prank(customer);
        mandate.approve("p3", dShare, issuer, 10 * USDC);
        (bool ok3,) = _exec("p3", dShare, issuer, 10 * USDC);
        assertTrue(ok3);
    }

    function test_copilotApprovalDoesNotOverrideTheCap() public {
        _set(Mandate.Mode.Copilot);
        vm.prank(customer);
        mandate.approve("p", dShare, issuer, PER_ORDER + 1);
        (bool ok, Mandate.Reason reason) = _exec("p", dShare, issuer, PER_ORDER + 1);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.OverPerOrderCap));
    }

    function test_onlyTheCustomerCanApprove() public {
        _set(Mandate.Mode.Copilot);
        // The agent "approving" writes under the agent's own address, where it has no mandate.
        vm.prank(agent);
        vm.expectRevert(Mandate.NoMandate.selector);
        mandate.approve("p", dShare, issuer, 10 * USDC);

        (bool ok, Mandate.Reason reason) = _exec("p", dShare, issuer, 10 * USDC);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Mandate.Reason.NotApproved));
    }

    // ---------------------------------------------------------- authorities

    function test_onlyTheNamedAgentCanSubmit() public {
        vm.prank(stranger);
        vm.expectRevert(Mandate.NotAgent.selector);
        mandate.execute(customer, "p", dShare, issuer, 10 * USDC);
    }

    function test_noMandateReverts() public {
        vm.prank(agent);
        vm.expectRevert(Mandate.NoMandate.selector);
        mandate.execute(stranger, "p", dShare, issuer, 10 * USDC);
    }

    function test_aProposalIdIsDecidedOnce() public {
        _exec("p", dShare, issuer, 10 * USDC);
        vm.prank(agent);
        vm.expectRevert(Mandate.ProposalAlreadyDecided.selector);
        mandate.execute(customer, "p", dShare, issuer, 10 * USDC);
    }

    function test_customerWithdrawingTheAllowanceStopsEverything() public {
        vm.prank(customer);
        usdc.approve(address(mandate), 0);
        vm.prank(agent);
        vm.expectRevert();
        mandate.execute(customer, "p", dShare, issuer, 10 * USDC);
        assertEq(usdc.balanceOf(issuer), 0);
    }

    function test_invalidTermsAreRefused() public {
        address[] memory none = new address[](0);
        vm.startPrank(customer);
        vm.expectRevert(Mandate.InvalidTerms.selector); // per-order cap above the daily cap
        mandate.setMandate(agent, address(usdc), Mandate.Mode.Copilot, 10, 5, uint64(block.timestamp + 1), none, none);
        vm.expectRevert(Mandate.InvalidTerms.selector); // already expired
        mandate.setMandate(agent, address(usdc), Mandate.Mode.Copilot, 5, 10, uint64(block.timestamp), none, none);
        vm.expectRevert(Mandate.InvalidTerms.selector); // customer naming itself as the agent
        mandate.setMandate(customer, address(usdc), Mandate.Mode.Copilot, 5, 10, uint64(block.timestamp + 1), none, none);
        vm.stopPrank();
    }
}
