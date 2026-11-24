// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Run through scripts/demo.sh (fresh anvil). Anvil's public dev keys only, so it refuses any other chain.

import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Leash, Terms, Position} from "../src/Leash.sol";
import {Local} from "./Local.s.sol";

/// @notice The two steps of the demo that are awkward in cast: the deploy (with a ThinBond rehearsal) and
///         "swap until the price reaches tick X". Everything else in scripts/demo.sh is plain cast.
contract Demo is Local {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// Local's stack without the bids and trades, every account's router and Leash approvals, and a rehearsal of
    /// createMandate with a 1% minBond (simulated, never sent) that must revert ThinBond.
    function deploy() external {
        require(block.chainid == 31337, "local anvil only");
        deployContracts();
        for (uint32 i; i <= SWAPPER; i++) {
            vm.startBroadcast(pk(i));
            tkn.approve(address(swapRouter), type(uint256).max);
            usdc.approve(address(swapRouter), type(uint256).max);
            usdc.approve(address(leash), type(uint256).max);
            vm.stopBroadcast();
        }

        (bool usdcIs0, uint256 a0, uint256 a1) = deposits();
        Position memory p = initialPosition(a0, a1);
        Terms memory t = terms(usdcIs0, p.liquidity, anchorLiquidity(a0, a1));
        t.minBond = 4_000e6; // 1% of the 400,000 mUSDC deposit, under the 2% floor
        vm.startPrank(addr(TREASURY));
        MockERC20(Currency.unwrap(key.currency0)).approve(address(leash), a0);
        MockERC20(Currency.unwrap(key.currency1)).approve(address(leash), a1);
        try leash.createMandate(key, openSqrtPriceX96, t, a0, a1, p) {
            revert("thin bond was accepted");
        } catch (bytes memory err) {
            require(bytes4(err) == Leash.ThinBond.selector, "expected ThinBond");
            console2.log("THINBOND createMandate(minBond = 4,000 mUSDC = 1% of deposit) reverted ThinBond()");
        }
        vm.stopPrank();

        postMandate();
        console2.log("ADDR router", address(swapRouter));
        console2.log("ADDR leash", address(leash));
        console2.log("ADDR tkn", address(tkn));
        console2.log("ADDR usdc", address(usdc));
        console2.log("ADDR pm", address(manager));
    }

    /// Account `who` swaps until spot reaches `tick` (exact input of its whole balance, stopped by the price limit).
    function swapTo(PoolSwapTest router, PoolKey calldata k, uint32 who, int24 tick) external {
        require(block.chainid == 31337, "local anvil only");
        (, int24 spot,,) = router.manager().getSlot0(k.toId());
        bool zeroForOne = tick < spot;
        MockERC20 tokenIn = MockERC20(Currency.unwrap(zeroForOne ? k.currency0 : k.currency1));
        uint256 amount = tokenIn.balanceOf(addr(who)) / 2;
        vm.startBroadcast(pk(who));
        router.swap(
            k,
            SwapParams(zeroForOne, -int256(amount), TickMath.getSqrtPriceAtTick(tick)),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        vm.stopBroadcast();
    }
}
