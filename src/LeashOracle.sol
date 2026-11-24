// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// One observation per block with a swap: the tick in force since the previous one, and the running sum.
struct Obs {
    uint32 time;
    int24 tick;
    int56 tickCumulative;
}

// ponytail: fixed 1024 observations. A pool swapped every block on 1s blocks holds ~17 min of history, less than
// a 30-min window, and the TWAP silently shortens to what is held. Upgrade: v3-style growable cardinality.
uint256 constant OBS = 1024;
// The oracle's recorded tick moves at most 50 ticks (~0.5%) per second from the previous observation's. That follows
// any genuine market (a 30% crash is reflected in ~1 minute, a full window still converges to the new price) but a
// price parked anywhere for one 12s block moves the recorded tick at most 600 ticks, and a 30-minute TWAP at most 4.
int256 constant MAX_MOVE = 50;

struct Oracle {
    uint16 index; // newest
    uint16 count;
    int24 open; // spot tick before the first swap of the newest observation's block
    Obs[OBS] obs;
}

/// @notice Leash's truncated TWAP oracle. An external library, linked into Leash, so the hook fits under EIP-170.
library LeashOracle {
    /// Called before every swap with the pre-swap tick, at most once per block, so a price pushed and
    /// returned within one block never enters the TWAP.
    function observe(Oracle storage o, int24 tick) external {
        Obs memory last = o.obs[o.index];
        if (last.time == block.timestamp) return;
        uint256 dt = block.timestamp - last.time;
        int24 r = _truncate(last.tick, tick, dt);
        uint16 i = uint16((o.index + 1) % OBS);
        o.obs[i] = Obs(uint32(block.timestamp), r, last.tickCumulative + int56(r) * int56(uint56(dt)));
        (o.index, o.open) = (i, tick);
        if (o.count < OBS) o.count++;
    }

    /// Time-weighted tick over the last `window` seconds, or over all history held if that is shorter, with
    /// `spot` the pool's current tick.
    function twap(Oracle storage o, int24 spot, uint32 window) external view returns (int24 tick) {
        Obs memory last = o.obs[o.index];
        // Spot since the last observation, truncated exactly as the next observation will record it, so the view
        // can't be pushed either.
        spot = _truncate(last.tick, spot, block.timestamp - last.time);
        uint256 oldest = o.count < OBS ? 0 : (o.index + 1) % OBS;
        Obs memory first = o.obs[oldest];

        uint256 target = block.timestamp > window ? block.timestamp - window : 0;
        if (target < first.time) target = first.time;
        if (target == block.timestamp) return first.tick; // all history is this block: the tick it opened at

        int56 cumThen;
        if (target >= last.time) {
            cumThen = last.tickCumulative + int56(spot) * int56(uint56(target - last.time));
        } else {
            uint256 lo; // binary search: obs[lo].time <= target < obs[hi].time
            uint256 hi = o.count - 1;
            while (hi - lo > 1) {
                uint256 mid = (lo + hi) / 2;
                if (o.obs[(oldest + mid) % OBS].time <= target) lo = mid;
                else hi = mid;
            }
            Obs memory a = o.obs[(oldest + lo) % OBS];
            cumThen = a.tickCumulative + int56(o.obs[(oldest + hi) % OBS].tick) * int56(uint56(target - a.time));
        }
        // Extrapolate to now with the spot tick, as v3 does: any swap this block already wrote an observation at now.
        int56 cumNow = last.tickCumulative + int56(spot) * int56(uint56(block.timestamp - last.time));
        int56 dt = int56(uint56(block.timestamp - target));
        tick = int24((cumNow - cumThen) / dt);
        if (cumNow < cumThen && (cumNow - cumThen) % dt != 0) tick--; // round toward negative infinity
    }

    /// `to`, moved at most MAX_MOVE ticks per second of `dt` away from `from`. dt needs no cap beyond overflow
    /// safety (int256): a long dt means the price really sat there with nobody trading against it.
    function _truncate(int24 from, int24 to, uint256 dt) private pure returns (int24) {
        int256 cap = MAX_MOVE * int256(dt);
        if (to > from + cap) return int24(from + cap);
        if (to < from - cap) return int24(from - cap);
        return to;
    }
}
