// Every write the app makes, as plain functions over a viem wallet client, so the same path runs from the
// browser (injected wallet) and from verify.ts (anvil test key). Each simulates first: a revert never costs gas
// and comes back as plain words (explain).
import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, erc20Abi, maxUint256, parseAbi,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { leashAbi, type Key, type Terms } from './chain.ts';

export type Ctx = { pub: PublicClient; wallet: WalletClient; account: Address; leash: Address };
export type Position = { tickLower: number; tickUpper: number; liquidity: bigint };

async function call(ctx: Ctx, functionName: string, args: unknown[], afterApprove = false, to: { address: Address; abi: Abi } = { address: ctx.leash, abi: leashAbi }): Promise<Hex> {
  const sim = () => ctx.pub.simulateContract({ address: to.address, abi: to.abi, functionName, args, account: ctx.account });
  // Public RPCs sit behind load balancers: right after an approval lands, the node that answers the simulation can be a
  // block behind and still see the old allowance. Give it a few seconds before believing a transfer failure.
  let res: Awaited<ReturnType<typeof sim>> | undefined;
  for (let i = 0; ; i++) {
    try { res = await sim(); break; } catch (e) {
      if (!afterApprove || i >= 5 || !/TRANSFER_FROM_FAILED|allowance/i.test(String((e as Error)?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const { request } = res;
  const hash = await ctx.wallet.writeContract({ ...request, account: ctx.account, chain: ctx.wallet.chain } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('The transaction reverted on-chain.');
  return hash;
}

/** Approves `amount` of `tokenAddr` to `spender` (Leash by default) unless the allowance already covers `need`. */
export async function approve(ctx: Ctx, tokenAddr: Address, amount: bigint, spender: Address = ctx.leash, need = amount): Promise<Hex | null> {
  if (amount === 0n) return null;
  const have = await ctx.pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'allowance', args: [ctx.account, spender] });
  if (have >= need) return null;
  const { request } = await ctx.pub.simulateContract({ address: tokenAddr, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account: ctx.account });
  const hash = await ctx.wallet.writeContract({ ...request, account: ctx.account, chain: ctx.wallet.chain } as never);
  await ctx.pub.waitForTransactionReceipt({ hash });
  return hash;
}
export const approveMax = (ctx: Ctx, tokenAddr: Address) => approve(ctx, tokenAddr, maxUint256);

export async function createMandate(ctx: Ctx, key: Key, sqrtPriceX96: bigint, t: Terms, amount0: bigint, amount1: bigint, initial: Position) {
  const a = await approve(ctx, key.currency0, amount0);
  const b = await approve(ctx, key.currency1, amount1);
  return call(ctx, 'createMandate', [key, sqrtPriceX96, t, amount0, amount1, initial], !!(a || b));
}
export async function bid(ctx: Ctx, key: Key, stable: Address, amount: bigint) {
  const a = await approve(ctx, stable, amount);
  return call(ctx, 'bid', [key, amount], !!a);
}
export const rebalance = (ctx: Ctx, key: Key, lo: number, hi: number, liq: bigint) => call(ctx, 'rebalance', [key, lo, hi, liq]);
export const setFee = (ctx: Ctx, key: Key, fee: number) => call(ctx, 'setFee', [key, fee]);
export const checkpoint = (ctx: Ctx, key: Key) => call(ctx, 'checkpoint', [key]);
export const settle = (ctx: Ctx, key: Key, epoch: number) => call(ctx, 'settle', [key, BigInt(epoch)]);
export const close = (ctx: Ctx, key: Key) => call(ctx, 'close', [key]);
export const claim = (ctx: Ctx, currency: Address) => call(ctx, 'claim', [currency]);

// ---------------------------------------------------------------- trading (testnets: Uniswap's PoolSwapTest router, open-mint test tokens)
const routerAbi = [...parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }',
  'struct TestSettings { bool takeClaims; bool settleUsingBurn; }',
  'function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)',
]), ...(leashAbi as Abi).filter((x) => x.type === 'error')] as Abi;
const MIN_SQRT = 4295128739n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

/** Exact-input swap. ponytail: no price limit (the app previews the result first); a real router needs one. The test
 *  router is approved once for the maximum, so later trades in this token take one signature. */
export async function swap(ctx: Ctx, router: Address, key: Key, zeroForOne: boolean, amountIn: bigint) {
  const a = await approve(ctx, zeroForOne ? key.currency0 : key.currency1, maxUint256, router, amountIn);
  const params = { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n };
  return call(ctx, 'swap', [key, params, { takeClaims: false, settleUsingBurn: false }, '0x'], !!a, { address: router, abi: routerAbi });
}
/** solmate MockERC20's open mint: the testnet tokens are worth nothing, so anyone can take some. */
export const mintTest = (ctx: Ctx, token: Address, amount: bigint) =>
  call(ctx, 'mint', [ctx.account, amount], false, { address: token, abi: parseAbi(['function mint(address to, uint256 value)']) });

// ---------------------------------------------------------------- reverts in plain words
const WORDS: Record<string, string> = {
  // Leash
  HookOnly: 'Only the Leash hook itself can create this pool or add liquidity to it.',
  NotLeashPool: 'This is not a valid Leash pool: the key must use the Leash hook, the dynamic-fee flag and two deployed ERC-20 tokens.',
  BadTerms: 'The mandate terms are out of bounds (see the checks beside the form).',
  ThinAnchor: 'The full-range anchor is too thin: it must hold at least ~19% of the deposit\'s value at the opening price.',
  ThinBond: 'The minimum bond is too small: it must be at least 2% of the deposit\'s value at the opening price.',
  NoMandate: 'There is no mandate for this pool.',
  MandateClosed: 'This mandate is closed.',
  AuctionClosed: 'Bidding has closed for this mandate.',
  LowBid: 'The bid is too low: it must be at least the minimum bond and strictly above the current leader\'s bond.',
  NotManager: 'Only the hired manager can do this, and the connected account is not the manager.',
  NotActive: 'The mandate is not active right now (still in auction, already ended, or nobody was hired).',
  NotTreasury: 'Only the treasury that posted this mandate can close it.',
  NotEnded: 'Too early: that epoch (or the mandate) has not ended yet.',
  FeeTooHigh: 'The fee is above the mandate\'s cap (maxFee).',
  FeeTooLow: 'The fee is below the mandate\'s floor (minFee).',
  TooShallow: 'That liquidity is below the depth floor (minLiquidity).',
  RangeMissesTwap: 'The range must reach at least minHalfWidth ticks either side of the TWAP, with the spot price strictly inside it.',
  SpotOffTwap: 'The pool price is too far from its TWAP. Re-ranging needs spot within maxTickDeviation ticks of the TWAP; growing the position needs it within 2 ticks. Wait for the price to settle.',
  SameBlock: 'Only one rebalance per block, and growth is refused once the price has moved in this block. Try again in the next block.',
  GrowTooFast: 'Growth is capped: at most +5% liquidity per rebalance, and only once per TWAP window.',
  Breached: 'The manager was fired: an epoch was out of compliance for twice its allowance and the whole bond went to the treasury.',
  BadEpoch: 'Epochs settle in order: that is not the next unsettled epoch.',
  NotPoolManager: 'Only the Uniswap PoolManager can call this.',
  // v4-core
  PoolAlreadyInitialized: 'A pool with exactly this key already exists (each pool can hold one mandate). Change the tick spacing to make a new pool.',
  TickMisaligned: 'A tick is not a multiple of the pool\'s tick spacing.',
  CurrenciesOutOfOrderOrEqual: 'The two tokens must differ, and currency0 must be the lower address.',
  TicksMisordered: 'The lower tick must be below the upper tick.',
  TickLowerOutOfBounds: 'The lower tick is below the minimum tick.',
  TickUpperOutOfBounds: 'The upper tick is above the maximum tick.',
  TickSpacingTooLarge: 'Tick spacing is too large (max 32767).',
  TickSpacingTooSmall: 'Tick spacing must be at least 1.',
  InvalidSqrtPrice: 'The opening price is outside Uniswap\'s price range.',
};

/** A wallet or revert error as one plain sentence. */
export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'You rejected the request in your wallet.';
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      let name = rev.data?.errorName;
      const args = rev.data?.args as unknown[] | undefined;
      if (name === 'WrappedError' && args) { // a hook revert wrapped by PoolManager: unwrap the reason
        try { name = decodeErrorResult({ abi: leashAbi, data: args[2] as Hex }).errorName; } catch { /* keep wrapped */ }
      }
      if (name === 'Panic' && args?.[0] === 0x11n) return 'Not enough of this mandate\'s own inventory for that: the liquidity needs more tokens than the mandate holds idle.';
      if (name === 'Error' && args) {
        const msg = String(args[0]);
        if (/TRANSFER_FROM_FAILED/.test(msg)) return 'A token transfer failed: check your balance and allowance.';
        return msg;
      }
      if (name && WORDS[name]) return WORDS[name];
      if (name) return `Reverted: ${name}.`;
      if (rev.reason) return rev.reason;
    }
    if (/insufficient funds/i.test(e.message)) return 'Not enough ETH for gas on this network.';
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
