// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Leash, Mandate} from "../src/Leash.sol";
import {Local} from "../script/Local.s.sol";
import {Settle} from "../script/Settle.s.sol";

/// The keeper's logic on the seeded local stack.
contract SettleTest is Test {
    Local local;
    Settle keeper;
    Leash leash;
    PoolKey key;
    PoolId id;
    uint256 start;
    uint256 len;

    function setUp() public {
        local = new Local();
        local.deployStack();
        keeper = new Settle();
        (leash, key, id) = (local.leash(), local.poolKey(), local.id());
        Mandate memory m = leash.mandate(id);
        (start, len) = (m.terms.auctionEnd, m.terms.epochLength);
    }

    function test_checkpointsThenSettlesExactlyTheEndedEpochsInOrder_thenNoop() public {
        (bool checkpointed, uint256 n) = keeper.keep(leash, key);
        assertFalse(checkpointed, "auction open: nothing to book");
        assertEq(n, 0);

        // First round after the auction: checkpoint books compliance and sweeps the setup swaps' fees to the treasury.
        Mandate memory before = leash.mandate(id);
        vm.warp(start + len / 2);
        (checkpointed, n) = keeper.keep(leash, key);
        assertTrue(checkpointed);
        assertEq(n, 0, "epoch 0 still running");
        Mandate memory m = leash.mandate(id);
        assertTrue(m.swept);
        assertGt(m.idle0, before.idle0, "pre-mandate fees went to the treasury (0)");
        assertGt(m.idle1, before.idle1, "pre-mandate fees went to the treasury (1)");
        assertEq(m.lastCheck, block.timestamp);
        assertEq(leash.epochRecord(id, 0).inSecs, len / 2, "first half of epoch 0 booked in compliance");

        vm.warp(start + len + 1); // epoch 0 ended, epoch 1 running
        assertEq(_kept(), _seq(0, 1));
        assertEq(leash.epochRecord(id, 0).inSecs, len, "all of epoch 0 in compliance");
        assertFalse(leash.epochRecord(id, 1).settled, "running epoch untouched");
        (checkpointed, n) = keeper.keep(leash, key);
        assertTrue(checkpointed, "keeps booking epoch 1");
        assertEq(n, 0, "nothing more to settle when run again");

        vm.warp(start + 3 * len + 1 days); // well past the end: epochs 1 and 2 remain
        assertEq(_kept(), _seq(1, 3));
        (checkpointed, n) = keeper.keep(leash, key);
        assertFalse(checkpointed, "mandate over and fully booked");
        assertEq(n, 0);

        (uint32 clean, uint32 breached) = leash.records(local.addr(2));
        assertEq(clean, 3, "an idle manager on a compliant seed stays clean");
        assertEq(breached, 0);

        vm.prank(local.addr(0));
        leash.close(key);
        (checkpointed, n) = keeper.keep(leash, key);
        assertFalse(checkpointed, "skips a closed mandate without reverting");
        assertEq(n, 0);
    }

    function test_stopsAtABreach() public {
        // After epoch 0 starts, the swapper dumps currency0 until spot sits 600 ticks under the position.
        vm.warp(start + 1);
        int24 below = leash.mandate(id).tickLower - 600;
        address swapper = local.addr(3);
        uint256 all = MockERC20(Currency.unwrap(key.currency0)).balanceOf(swapper);
        PoolSwapTest router = local.swapRouter();
        vm.prank(swapper);
        router.swap(
            key,
            SwapParams(true, -int256(all), TickMath.getSqrtPriceAtTick(below)),
            PoolSwapTest.TestSettings(false, false),
            ""
        );

        vm.warp(start + 3 * len); // every epoch ended
        assertEq(_kept(), _seq(0, 1), "epoch 0 breaches, and the keeper stops there");
        assertFalse(leash.epochRecord(id, 0).clean);
        assertTrue(leash.mandate(id).breached);
        (bool checkpointed, uint256 n) = keeper.keep(leash, key);
        assertFalse(checkpointed, "nothing to book once breached");
        assertEq(n, 0, "no-op once breached");
    }

    /// Runs a keeper round and returns the epochs it settled, in emission order.
    function _kept() internal returns (uint256[] memory epochs) {
        vm.recordLogs();
        (, uint256 n) = keeper.keep(leash, key);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        epochs = new uint256[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == Leash.EpochSettled.selector) epochs[j++] = uint256(logs[i].topics[2]);
        }
        assertEq(j, n, "one EpochSettled per settled epoch");
    }

    function _seq(uint256 from, uint256 to) internal pure returns (uint256[] memory s) {
        s = new uint256[](to - from);
        for (uint256 i; i < s.length; i++) {
            s[i] = from + i;
        }
    }
}
