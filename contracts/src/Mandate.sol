// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Mandate
/// @notice The limits a customer sets on what an agent may do with the customer's settlement
///         token (USDC), enforced on-chain, with every decision written to the event log.
///
/// Non-custodial by construction:
///  - This contract never holds a balance. A payment moves straight from the customer's wallet to
///    an allowlisted recipient with `transferFrom`, under an ERC-20 allowance the customer grants
///    and can withdraw at any time.
///  - There is no admin, no owner of the contract, no upgrade path and no pause. The only party
///    who can set, change or revoke a customer's mandate is that customer's own address.
///  - The agent can only ever cause a transfer that passes every check below.
///
/// A proposal that fails a mandate check is not reverted. It is recorded as rejected, with the
/// reason, so the refusal has a transaction hash and appears in the audit record. Calls from an
/// address that is not the customer's named agent revert.
contract Mandate {
    /// Copilot: the agent proposes and the customer approves each proposal before it can execute.
    /// Autopilot: the agent executes inside the limits without a per-proposal approval.
    enum Mode {
        Copilot,
        Autopilot
    }

    enum Reason {
        None,
        Revoked,
        Expired,
        AssetNotAllowed,
        RecipientNotAllowed,
        OverPerOrderCap,
        OverDailyCap,
        NotApproved
    }

    enum Status {
        None,
        Executed,
        Rejected
    }

    struct Terms {
        address agent; // the only address that may submit proposals for this customer
        address settlementToken; // the token that moves (USDC)
        Mode mode;
        bool revoked;
        uint64 expiry; // unix seconds; proposals at or after this time are rejected
        uint64 version; // increments every time the customer sets a mandate
        uint256 perOrderCap; // settlement-token base units
        uint256 dailyCap; // settlement-token base units, over the rolling window below
    }

    /// Spend is tracked in hourly buckets. The rolling cap sums the current hour and the 24 hours
    /// before it, so the window is at least 24 hours and never shorter: the agent can never move
    /// more than `dailyCap` in any 24-hour period.
    uint256 public constant BUCKET_SECONDS = 1 hours;
    uint256 public constant WINDOW_BUCKETS = 25;

    mapping(address customer => Terms) private _terms;
    mapping(address customer => mapping(uint64 version => mapping(address asset => bool))) public assetAllowed;
    mapping(address customer => mapping(uint64 version => mapping(address recipient => bool))) public recipientAllowed;
    mapping(address customer => mapping(uint256 bucket => uint256 spent)) private _spent;
    mapping(address customer => mapping(bytes32 proposalId => Status)) public proposalStatus;
    /// Copilot approvals: hash of (version, asset, recipient, amount) the customer approved.
    mapping(address customer => mapping(bytes32 proposalId => bytes32 approvedHash)) public approvals;

    event MandateSet(
        address indexed customer,
        uint64 indexed version,
        address indexed agent,
        address settlementToken,
        Mode mode,
        uint256 perOrderCap,
        uint256 dailyCap,
        uint64 expiry,
        address[] assets,
        address[] recipients
    );
    event MandateRevoked(address indexed customer, uint64 indexed version);
    event ProposalApproved(
        address indexed customer,
        bytes32 indexed proposalId,
        uint64 indexed version,
        address approver,
        address asset,
        address recipient,
        uint256 amount
    );
    event ProposalExecuted(
        address indexed customer,
        bytes32 indexed proposalId,
        uint64 indexed version,
        address agent,
        address asset,
        address recipient,
        uint256 amount
    );
    event ProposalRejected(
        address indexed customer,
        bytes32 indexed proposalId,
        uint64 indexed version,
        address agent,
        address asset,
        address recipient,
        uint256 amount,
        Reason reason
    );

    error NoMandate();
    error NotAgent();
    error ProposalAlreadyDecided();
    error InvalidTerms();
    error TransferFailed();

    // ---------------------------------------------------------------- customer

    /// @notice Set or replace the caller's mandate. Each call starts a new version with fresh
    ///         allowlists. Spend already counted in the rolling window carries over.
    /// @param assets     Assets the agent may act on. Include the settlement token itself to allow
    ///                   plain settlement-token payments.
    /// @param recipients Addresses the settlement token may be sent to.
    function setMandate(
        address agent,
        address settlementToken,
        Mode mode,
        uint256 perOrderCap,
        uint256 dailyCap,
        uint64 expiry,
        address[] calldata assets,
        address[] calldata recipients
    ) external returns (uint64 version) {
        if (
            agent == address(0) || agent == msg.sender || settlementToken == address(0) || perOrderCap == 0
                || perOrderCap > dailyCap || expiry <= block.timestamp
        ) revert InvalidTerms();

        version = _terms[msg.sender].version + 1;
        _terms[msg.sender] = Terms({
            agent: agent,
            settlementToken: settlementToken,
            mode: mode,
            revoked: false,
            expiry: expiry,
            version: version,
            perOrderCap: perOrderCap,
            dailyCap: dailyCap
        });
        for (uint256 i = 0; i < assets.length; i++) {
            assetAllowed[msg.sender][version][assets[i]] = true;
        }
        for (uint256 i = 0; i < recipients.length; i++) {
            recipientAllowed[msg.sender][version][recipients[i]] = true;
        }
        emit MandateSet(
            msg.sender, version, agent, settlementToken, mode, perOrderCap, dailyCap, expiry, assets, recipients
        );
    }

    /// @notice Revoke the caller's mandate. Every later proposal is rejected until a new one is set.
    function revoke() external {
        Terms storage t = _terms[msg.sender];
        if (t.version == 0) revert NoMandate();
        t.revoked = true;
        emit MandateRevoked(msg.sender, t.version);
    }

    /// @notice Copilot: the customer approves one specific proposal under the current version.
    function approve(bytes32 proposalId, address asset, address recipient, uint256 amount) external {
        Terms storage t = _terms[msg.sender];
        if (t.version == 0) revert NoMandate();
        if (proposalStatus[msg.sender][proposalId] != Status.None) revert ProposalAlreadyDecided();
        approvals[msg.sender][proposalId] = _approvalHash(t.version, asset, recipient, amount);
        emit ProposalApproved(msg.sender, proposalId, t.version, msg.sender, asset, recipient, amount);
    }

    // ------------------------------------------------------------------- agent

    /// @notice Submit a proposal for `customer`. If it passes every mandate check, `amount` of the
    ///         settlement token moves from the customer to `recipient` and the proposal is recorded
    ///         as executed. If it fails a check, nothing moves and it is recorded as rejected.
    /// @param asset The asset the action is for (for a plain payment, the settlement token).
    /// @return executed True if the transfer happened.
    /// @return reason   Why it was rejected, or `Reason.None`.
    function execute(address customer, bytes32 proposalId, address asset, address recipient, uint256 amount)
        external
        returns (bool executed, Reason reason)
    {
        Terms storage t = _terms[customer];
        if (t.version == 0) revert NoMandate();
        if (msg.sender != t.agent) revert NotAgent();
        if (proposalStatus[customer][proposalId] != Status.None) revert ProposalAlreadyDecided();

        reason = _check(customer, t, proposalId, asset, recipient, amount);
        if (reason != Reason.None) {
            proposalStatus[customer][proposalId] = Status.Rejected;
            emit ProposalRejected(customer, proposalId, t.version, msg.sender, asset, recipient, amount, reason);
            return (false, reason);
        }

        proposalStatus[customer][proposalId] = Status.Executed;
        _spent[customer][block.timestamp / BUCKET_SECONDS] += amount;
        emit ProposalExecuted(customer, proposalId, t.version, msg.sender, asset, recipient, amount);
        _safeTransferFrom(t.settlementToken, customer, recipient, amount);
        return (true, Reason.None);
    }

    // ------------------------------------------------------------------- views

    function terms(address customer) external view returns (Terms memory) {
        return _terms[customer];
    }

    /// @notice Settlement token already spent by the agent inside the current rolling window.
    function spentInWindow(address customer) public view returns (uint256 total) {
        uint256 current = block.timestamp / BUCKET_SECONDS;
        for (uint256 i = 0; i < WINDOW_BUCKETS && i <= current; i++) {
            total += _spent[customer][current - i];
        }
    }

    /// @notice What `execute` would decide right now, without submitting.
    function preview(address customer, bytes32 proposalId, address asset, address recipient, uint256 amount)
        external
        view
        returns (Reason)
    {
        Terms storage t = _terms[customer];
        if (t.version == 0) revert NoMandate();
        return _check(customer, t, proposalId, asset, recipient, amount);
    }

    // ---------------------------------------------------------------- internal

    function _check(
        address customer,
        Terms storage t,
        bytes32 proposalId,
        address asset,
        address recipient,
        uint256 amount
    ) private view returns (Reason) {
        if (t.revoked) return Reason.Revoked;
        if (block.timestamp >= t.expiry) return Reason.Expired;
        if (!assetAllowed[customer][t.version][asset]) return Reason.AssetNotAllowed;
        if (!recipientAllowed[customer][t.version][recipient]) return Reason.RecipientNotAllowed;
        if (amount > t.perOrderCap) return Reason.OverPerOrderCap;
        if (spentInWindow(customer) + amount > t.dailyCap) return Reason.OverDailyCap;
        if (
            t.mode == Mode.Copilot
                && approvals[customer][proposalId] != _approvalHash(t.version, asset, recipient, amount)
        ) return Reason.NotApproved;
        return Reason.None;
    }

    function _approvalHash(uint64 version, address asset, address recipient, uint256 amount)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(version, asset, recipient, amount));
    }

    /// Accepts tokens that return true and tokens that return nothing; anything else reverts.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || (data.length == 0 && token.code.length == 0)) {
            revert TransferFailed();
        }
    }
}
