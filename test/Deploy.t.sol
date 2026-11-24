// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Leash, Mandate} from "../src/Leash.sol";
import {Local} from "../script/Local.s.sol";

/// Runs the deploy scripts' logic (not their JSON writing) against a fresh PoolManager.
contract DeployTest is Test {
    using StateLibrary for IPoolManager;

    Local local;
    Leash leash;

    function setUp() public {
        local = new Local();
        local.deployStack();
        leash = local.leash();
    }

    function test_hookAddressEncodesExactlyItsPermissions() public view {
        Hooks.Permissions memory p = leash.getHookPermissions();
        assertEq(uint160(address(leash)) & Hooks.ALL_HOOK_MASK, local.flags(p), "low 14 bits == permissions");
        Hooks.validateHookPermissions(IHooks(address(leash)), p); // v4-core's own per-flag check
        assertEq(address(leash.poolManager()), address(local.manager()));
    }

    function test_seededMandate() public view {
        Mandate memory m = leash.mandate(local.id());
        assertEq(m.treasury, local.addr(0));
        assertEq(m.manager, local.addr(2), "manager #2 leads");
        assertEq(m.bond, local.BID2());
        assertEq(leash.owed(local.addr(1), Currency.wrap(address(local.usdc()))), local.BID1(), "#1 outbid, can claim");
        assertGt(m.terms.auctionEnd, block.timestamp, "auction still open");
        assertFalse(m.closed);

        // Idle is the deposits minus what the opening position took at the opening price; swaps don't touch it.
        uint160 open = local.openSqrtPriceX96();
        uint160 lo = TickMath.getSqrtPriceAtTick(m.tickLower);
        uint160 hi = TickMath.getSqrtPriceAtTick(m.tickUpper);
        bool usdcIs0 = m.terms.stableIs0;
        (uint256 d0, uint256 d1) =
            usdcIs0 ? (local.USDC_DEPOSIT(), local.TKN_DEPOSIT()) : (local.TKN_DEPOSIT(), local.USDC_DEPOSIT());
        assertEq(m.idle0, d0 - SqrtPriceMath.getAmount0Delta(open, hi, m.liquidity, true));
        assertEq(m.idle1, d1 - SqrtPriceMath.getAmount1Delta(lo, open, m.liquidity, true));
        assertApproxEqRel(m.idle0, d0 / 2, 0.01e18, "about half of each deposit stays idle");
        assertGt(m.liquidity, m.terms.minLiquidity, "opening position clears the depth floor");
        (uint256 idleTkn, uint256 idleUsdc) = usdcIs0 ? (m.idle1, m.idle0) : (m.idle0, m.idle1);
        assertEq(local.tkn().balanceOf(address(leash)), idleTkn, "ledger == balance (TKN)");
        assertEq(local.usdc().balanceOf(address(leash)), idleUsdc + local.BID1() + local.BID2(), "ledger == balance (mUSDC)");

        IPoolManager pm = local.manager();
        (, int24 tick,, uint24 lpFee) = pm.getSlot0(local.id());
        assertEq(lpFee, m.terms.maxFee, "fee starts at the cap");
        // 1 TKN = 2 mUSDC across 18 vs 6 decimals: raw price 2e-12 (tick ~ -269393) or its inverse; swapper moved it a bit.
        assertApproxEqAbs(tick, usdcIs0 ? int24(269393) : int24(-269393), 20);
        assertTrue(tick >= m.tickLower && tick < m.tickUpper, "in range after the swaps");
        (bool inRange, bool deep, bool onPace,) = leash.compliance(local.poolKey());
        assertTrue(inRange && deep && onPace, "seeded mandate starts compliant");
    }
}
