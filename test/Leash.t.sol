// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, stdError} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Leash, Terms, Mandate} from "../src/Leash.sol";

contract LeashTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    Leash leash;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint40 auctionEnd;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address hook = address(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG) ^ (0x4444 << 144));
        deployCodeTo("Leash.sol:Leash", abi.encode(manager), hook);
        leash = Leash(hook);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));

        MockERC20(Currency.unwrap(currency0)).approve(hook, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(hook, type(uint256).max);
        auctionEnd = uint40(block.timestamp + 1 days);
        leash.createMandate(key, SQRT_PRICE_1_1, _terms(), 100e18, 100e18);

        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            MockERC20(Currency.unwrap(currency1)).mint(who, 1_000e18);
            vm.prank(who);
            MockERC20(Currency.unwrap(currency1)).approve(hook, type(uint256).max);
        }
    }

    function _terms() internal view returns (Terms memory) {
        return Terms({
            stableIs0: false, maxFee: 10_000, auctionEnd: auctionEnd, epochLength: 1 days, epochs: 3, minBond: 10e18
        });
    }

    function _m() internal view returns (Mandate memory) {
        return leash.mandate(key.toId());
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    function _win() internal {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd);
    }

    function test_createMandate_initsPoolAndHoldsInventory() public view {
        (uint160 sqrtPrice,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(sqrtPrice, SQRT_PRICE_1_1);
        assertEq(lpFee, 10_000, "starts at the fee cap");
        assertEq(_m().treasury, address(this));
        assertEq(_bal(currency0, address(leash)), 100e18);
        assertEq(_bal(currency1, address(leash)), 100e18);
    }

    function test_outsiderCannotAddLiquidity() public {
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function test_outsiderCannotCreateLeashPool() public {
        PoolKey memory other = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(leash)));
        vm.expectRevert();
        manager.initialize(other, SQRT_PRICE_1_1);
    }

    function test_bid_highestWins_outbidCanClaim() public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(bob);
        vm.expectRevert(Leash.LowBid.selector);
        leash.bid(key, 10e18);
        vm.prank(bob);
        leash.bid(key, 20e18);

        assertEq(_m().manager, bob);
        assertEq(leash.owed(alice, currency1), 10e18);
        vm.prank(alice);
        leash.claim(currency1);
        assertEq(_bal(currency1, alice), 1_000e18, "alice made whole");

        vm.warp(auctionEnd);
        vm.prank(alice);
        vm.expectRevert(Leash.AuctionClosed.selector);
        leash.bid(key, 30e18);
    }

    function test_rebalance_onlyManager_onlyWhenActive() public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(alice);
        vm.expectRevert(Leash.NotActive.selector);
        leash.rebalance(key, -600, 600, 1e18);

        vm.warp(auctionEnd);
        vm.prank(bob);
        vm.expectRevert(Leash.NotManager.selector);
        leash.rebalance(key, -600, 600, 1e18);
    }

    function test_rebalance_swap_ledgerMatchesBalances() public {
        _win();
        vm.prank(alice);
        leash.rebalance(key, -600, 600, 1_000e18);
        assertEq(manager.getLiquidity(key.toId()), 1_000e18, "hook liquidity is live");

        swap(key, true, -1e18, ZERO_BYTES); // someone buys currency1 with currency0

        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 0); // pull everything back
        Mandate memory m = _m();
        assertGt(m.idle0, 100e18, "received currency0 from the swapper");
        assertLt(m.idle1, 100e18, "sold currency1 to the swapper");
        assertGt(m.idle0 + m.idle1, 200e18, "earned the fee");
        assertEq(_bal(currency0, address(leash)), m.idle0, "ledger == balance (0)");
        assertEq(_bal(currency1, address(leash)), m.idle1 + m.bond, "ledger == balance (1)");
    }

    /// The hook holds 110 currency1 (100 inventory + 10 bond). A range below the price needs only
    /// currency1; ~105 of it must fail on the ledger even though the hook's balance could pay.
    function test_rebalance_cannotSpendTheBond() public {
        _win();
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        leash.rebalance(key, -1200, -60, 1_900e18);
    }

    function test_setFee_capped() public {
        _win();
        vm.startPrank(alice);
        vm.expectRevert(Leash.FeeTooHigh.selector);
        leash.setFee(key, 10_001);
        leash.setFee(key, 500);
        vm.stopPrank();
        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 500);
    }

    function test_close_returnsEverything() public {
        _win();
        vm.prank(alice);
        leash.rebalance(key, -600, 600, 1_000e18);

        vm.expectRevert(Leash.NotEnded.selector);
        leash.close(key);
        vm.warp(auctionEnd + 3 days);
        vm.prank(alice);
        vm.expectRevert(Leash.NotTreasury.selector);
        leash.close(key);

        uint256 before0 = _bal(currency0, address(this));
        uint256 before1 = _bal(currency1, address(this));
        leash.close(key);
        assertApproxEqAbs(_bal(currency0, address(this)) - before0, 100e18, 2, "treasury got currency0 back");
        assertApproxEqAbs(_bal(currency1, address(this)) - before1, 100e18, 2, "treasury got currency1 back");
        assertEq(leash.owed(alice, currency1), 10e18, "bond returned");
        assertEq(manager.getLiquidity(key.toId()), 0);
    }

    function test_close_noBids_afterAuction() public {
        vm.warp(auctionEnd);
        leash.close(key);
        assertTrue(_m().closed);
        assertEq(_bal(currency0, address(leash)), 0);
    }
}
