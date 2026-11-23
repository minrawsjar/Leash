// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
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

    function test_seededMandate() public {
        Mandate memory m = leash.mandate(local.id());
        assertEq(m.treasury, local.addr(0));
        assertEq(m.manager, local.addr(2), "manager #2 leads");
        assertEq(m.bond, local.BID2());
        assertEq(leash.owed(local.addr(1), Currency.wrap(address(local.usdc()))), local.BID1(), "#1 outbid, can claim");
        assertGt(m.terms.auctionEnd, block.timestamp, "auction still open");
        assertFalse(m.closed);

        bool usdcIs0 = m.terms.stableIs0;
        assertEq(m.idle0, usdcIs0 ? local.USDC_DEPOSIT() : local.TKN_DEPOSIT());
        assertEq(m.idle1, usdcIs0 ? local.TKN_DEPOSIT() : local.USDC_DEPOSIT());
        assertEq(local.tkn().balanceOf(address(leash)), local.TKN_DEPOSIT());
        assertEq(local.usdc().balanceOf(address(leash)), local.USDC_DEPOSIT() + local.BID1() + local.BID2());

        IPoolManager pm = local.manager();
        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = pm.getSlot0(local.id());
        assertGt(sqrtPriceX96, 0, "pool initialized");
        assertEq(lpFee, m.terms.maxFee, "fee starts at the cap");
        // 1 TKN = 2 mUSDC across 18 vs 6 decimals: raw price 2e-12 (tick ~ -269393) or its inverse.
        assertApproxEqAbs(tick, usdcIs0 ? int24(269393) : int24(-269393), 1);
    }
}
