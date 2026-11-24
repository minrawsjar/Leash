// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Leash, Terms, Position, Mandate, EpochRecord} from "../../src/Leash.sol";

/// Drives one mandate with random bids, manager actions, swaps, settlements, claims, closes and time.
/// The handler is the treasury and the swapper; alice and bob bid and manage.
contract Handler is Test {
    using PoolIdLibrary for PoolKey;

    uint256 constant START = 10_000e18; // each bidder's starting stablecoin (currency1)
    uint256 constant FEE_BPS = 3000;

    Leash immutable leash;
    PoolSwapTest immutable router;
    PoolKey key;
    PoolId immutable id;
    address[2] public bidders = [makeAddr("alice"), makeAddr("bob")];
    /// Ghosts: pay earned by the settlement rules, and bonds lost to breaches.
    mapping(address => uint256[2]) public pay;
    mapping(address => uint256) public slashed;

    constructor(Leash _leash, PoolSwapTest _router, PoolKey memory _key) {
        (leash, router, key, id) = (_leash, _router, _key, _key.toId());
        Currency[2] memory cs = [key.currency0, key.currency1];
        for (uint256 i; i < 2; i++) {
            MockERC20 token = MockERC20(Currency.unwrap(cs[i]));
            token.mint(address(this), 1e30);
            token.approve(address(leash), type(uint256).max);
            token.approve(address(router), type(uint256).max);
        }
        for (uint256 i; i < 2; i++) {
            MockERC20(Currency.unwrap(key.currency1)).mint(bidders[i], START);
            vm.prank(bidders[i]);
            MockERC20(Currency.unwrap(key.currency1)).approve(address(leash), type(uint256).max);
        }
        Terms memory t = Terms({
            stableIs0: false,
            maxFee: 10_000,
            auctionEnd: uint40(block.timestamp + 1 hours),
            epochLength: 6 hours,
            epochs: 4,
            minBond: 10e18,
            twapWindow: 600,
            maxTickDeviation: 200,
            minLiquidity: 100e18,
            uptimeBps: 9000,
            managerFeeBps: uint16(FEE_BPS),
            startStableBps: 6000,
            endStableBps: 9000,
            minFee: 500,
            minHalfWidth: 400,
            anchorLiquidity: 200e18 // full range, ~200 of each token: 20% of the inventory
        });
        leash.createMandate(key, TickMath.getSqrtPriceAtTick(0), t, 1_000e18, 1_000e18, Position(-600, 600, 2_000e18));
    }

    function bid(uint256 who, uint256 amount) external {
        vm.prank(bidders[who % 2]);
        try leash.bid(key, bound(amount, 10e18, 1_000e18)) {} catch {}
    }

    /// A range around the TWAP (sometimes shifted off it), any size.
    function rebalance(int256 shift, uint256 below, uint256 above, uint256 liq) external {
        int24 c = leash.twapTick(key) / 60 * 60 + int24(bound(shift, -5, 5)) * 60;
        int24 lo = c - int24(int256(bound(below, 1, 20))) * 60;
        int24 hi = c + int24(int256(bound(above, 1, 20))) * 60;
        vm.prank(_manager());
        try leash.rebalance(key, lo, hi, uint128(bound(liq, 50e18, 6_000e18))) {} catch {}
    }

    function setFee(uint256 fee) external {
        vm.prank(_manager());
        try leash.setFee(key, uint24(bound(fee, 0, 20_000))) {} catch {}
    }

    function swap(bool zeroForOne, uint256 amount) external {
        SwapParams memory p = SwapParams(
            zeroForOne,
            -int256(bound(amount, 1e15, 100e18)),
            TickMath.getSqrtPriceAtTick(zeroForOne ? int24(-3000) : int24(3000))
        );
        try router.swap(key, p, PoolSwapTest.TestSettings(false, false), "") {} catch {}
    }

    function settle() external {
        Mandate memory m = leash.mandate(id);
        try leash.settle(key, m.settled) {
            _book(m);
        } catch {}
    }

    function checkpoint() external {
        try leash.checkpoint(key) {} catch {}
    }

    function close() external {
        Mandate memory m = leash.mandate(id);
        try leash.close(key) {
            _book(m);
        } catch {}
    }

    function claim(uint256 who, bool zero) external {
        vm.prank(who % 3 == 2 ? address(this) : bidders[who % 3]);
        leash.claim(zero ? key.currency0 : key.currency1);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
        vm.roll(block.number + 1);
    }

    /// Mirrors the settlement rules over the epochs settled by the last call.
    function _book(Mandate memory before) internal {
        for (uint256 e = before.settled; e < leash.mandate(id).settled; e++) {
            EpochRecord memory r = leash.epochRecord(id, e);
            if (r.clean) {
                pay[before.manager][0] += uint256(r.fees0) * FEE_BPS / 10_000;
                pay[before.manager][1] += uint256(r.fees1) * FEE_BPS / 10_000;
            } else {
                slashed[before.manager] += before.bond;
            }
        }
    }

    function _manager() internal view returns (address) {
        return leash.mandate(id).manager;
    }
}

contract LeashInvariantTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    Leash leash;
    Handler handler;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        address hook = address(
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG)
                ^ (0x4444 << 144)
        );
        deployCodeTo("Leash.sol:Leash", abi.encode(manager), hook);
        leash = Leash(hook);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));
        handler = new Handler(leash, swapRouter, key);

        bytes4[] memory s = new bytes4[](9);
        (s[0], s[1], s[2], s[3]) =
        (Handler.bid.selector, Handler.rebalance.selector, Handler.setFee.selector, Handler.swap.selector);
        (s[4], s[5], s[6], s[7], s[8]) =
        (
            Handler.settle.selector,
            Handler.close.selector,
            Handler.claim.selector,
            Handler.warp.selector,
            Handler.checkpoint.selector
        );
        targetSelector(FuzzSelector(address(handler), s));
        targetContract(address(handler));
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    /// The hook's real balances are exactly: inventory + unsettled fees + bond + everything it owes.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_hookHoldsExactlyItsLedger() public view {
        Mandate memory m = leash.mandate(key.toId());
        address[3] memory who = [address(handler), handler.bidders(0), handler.bidders(1)];
        uint256 owed0;
        uint256 owed1;
        for (uint256 i; i < 3; i++) {
            owed0 += leash.owed(who[i], currency0);
            owed1 += leash.owed(who[i], currency1);
        }
        assertEq(_bal(currency0, address(leash)), m.idle0 + m.fees0 + owed0, "currency0");
        assertEq(_bal(currency1, address(leash)), m.idle1 + m.fees1 + owed1 + m.bond, "currency1");
    }

    /// A bidder never ends up with more than they started with plus the pay the rules gave them, and every
    /// unit of their bond is in their wallet, owed back, still posted, or slashed.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_managersGainOnlyTheirPay() public view {
        Mandate memory m = leash.mandate(key.toId());
        for (uint256 i; i < 2; i++) {
            address a = handler.bidders(i);
            uint256 start = 10_000e18;
            (uint256 pay0, uint256 pay1) = (handler.pay(a, 0), handler.pay(a, 1));
            assertLe(_bal(currency0, a), pay0, "currency0 gain");
            assertLe(_bal(currency1, a), start + pay1, "currency1 gain");
            assertEq(_bal(currency0, a) + leash.owed(a, currency0), pay0);
            assertEq(
                _bal(currency1, a) + leash.owed(a, currency1) + (m.manager == a ? m.bond : 0) + handler.slashed(a),
                start + pay1
            );
        }
    }
}
