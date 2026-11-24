import { useEffect, useRef, type CSSProperties, type JSX } from 'react';
import { AttackChart } from '../AttackChart';
import { mount } from './motion';
import './site.css';

const cv = (o: Record<string, string | number>) => o as CSSProperties;
const APP = './app';
const REPO = 'https://github.com/minrawsjar/Leash';
const SOURCE = `${REPO}/blob/main/src/Leash.sol`;
const HOOK = '0x9F1e080eFA57938d394e41d58702912371346880';
const SCAN = `https://unichain-sepolia.blockscout.com/address/${HOOK}`;

const Chevron = () => (
  <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
/** The mark: a price line held between the two edges of a range. */
export const Mark = ({ size = 28 }: { size?: number }) => (
  <svg className="mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <rect x="1" y="1" width="26" height="26" rx="8" fill="var(--mint)" />
    <path d="M6 9.5h16M6 18.5h16" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
    <path d="M5.5 15.5l3.4-3 3.2 2.4 3.6-4 3.1 3 3.7-2.6" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

// Small line drawings for the defence cards, in the page's own vocabulary: a range, a line, bars.
const ICONS: Record<string, JSX.Element> = {
  guard: (<><path d="M8 30h72M8 58h72" className="i-edge" /><path d="M8 46l12-6 10 4 10-8 10 6" className="i-line" /><path d="M50 42l6-30" className="i-spike" /><path d="M60 16l12 12M72 16L60 28" className="i-x" /></>),
  anchor: (<>{Array.from({ length: 11 }, (_, i) => <rect key={i} x={6 + i * 7.4} y={i > 3 && i < 8 ? 30 : 58} width="5" height={i > 3 && i < 8 ? 40 : 12} className={i > 3 && i < 8 ? 'i-bar' : 'i-bar i-bar--low'} />)}</>),
  sandwich: (<><path d="M8 26h72M8 62h72" className="i-edge" /><rect x="26" y="36" width="36" height="16" rx="4" className="i-block" /><path d="M14 44h8M66 44h8" className="i-line" /></>),
  oracle: (<><path d="M8 70h72" className="i-edge" /><path d="M8 56l16 0 0-4 16 0 0-4 16 0 0-4 16 0" className="i-line" /><path d="M24 56L24 14" className="i-spike" /></>),
  growth: (<>{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={10 + i * 15} y={66 - (20 + i * 4)} width="11" height={20 + i * 4} className="i-bar" />)}<path d="M8 22l72-8" className="i-edge" /></>),
  grief: (<><path d="M8 28h72M8 60h72" className="i-edge" /><path d="M8 46l14-2 14 3 14-2 14 2 14-1" className="i-line" /><path d="M8 50l14-4 6 30 6-28 16 2 14-4 16 0" className="i-spot" /></>),
};

const DEFENCES: [string, string, string][] = [
  ['guard', 'Rebalance guard', 'Liquidity can only be placed while the pool price is close to the hook’s own TWAP. A price pushed for one block is far from the average, so the rebalance reverts.'],
  ['anchor', 'Permanent anchor', 'A full-range position the manager can never move, worth at least about 20% of the deposit. With no empty price range, holding the price anywhere costs capital and invites arbitrage.'],
  ['sandwich', 'Sandwich guards', 'One rebalance per block, a minimum range width around the TWAP and a fee floor. A manager who nudges the price and re-ranges behind it meets the same liquidity both ways.'],
  ['oracle', 'Truncated oracle', 'Each recorded price moves at most 50 ticks, about 0.5%, a second. A real crash shows up within a minute or so; a price parked for one block moves the 30-minute TWAP by a few ticks.'],
  ['growth', '5% growth cap', 'The position grows only while spot sits at the TWAP, and by at most 5% per TWAP window. Re-ranging and shrinking are never rate-limited.'],
  ['grief', 'Grief guard', 'Compliance is measured against the TWAP, not the current price. An outsider can’t knock the price out of range for one block to get the manager slashed.'],
];

const FLOW: string[][] = [
  ['createMandate|Treasury', 'bid 18,000 USDC|Bid', 'bid 25,000 USDC|Bid', 'rebalance −600 → 600|Manager'],
  ['swap 1,240 USDC|Checked', 'checkpoint 60s|Keeper', 'setFee 0.18%|Manager', 'settle epoch 3|Clean'],
  ['claim 1,174 USDC|Pay', 'swap 8,500 TKN|Checked', 'settle epoch 4|Slashed', 'close|Treasury'],
];

export function Site() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => mount(root.current!), []);
  return (
    <div className="site" ref={root}>
      <a className="skip" href="#story">Skip to how it works</a>

      <header className="nav" id="nav">
        <div className="nav__bar">
          <a className="brand" href="./" aria-label="Leash, back to top"><Mark /><span>leash</span></a>
          <nav className="menu" aria-label="Main">
            <button className="menu__trigger" type="button" aria-expanded="false" aria-controls="menu-protocol">Protocol <Chevron /></button>
            <button className="menu__trigger" type="button" aria-expanded="false" aria-controls="menu-resources">Resources <Chevron /></button>
          </nav>
          <a className="btn btn--primary btn--small nav__cta" href={APP}>Launch app</a>
          <button className="menu__toggle" type="button" aria-expanded="false" aria-controls="menu-sheet" aria-label="Menu"><span></span><span></span></button>
          <div className="menu__sheet" id="menu-sheet">
            <div className="menu__panel" id="menu-protocol" role="region" aria-label="Protocol">
              <p className="menu__heading">Protocol</p>
              <div className="menu__cols">
                <div className="menu__col"><p className="menu__label">How it works</p>
                  <a className="menu__link" href="#story"><strong>One mandate, start to end</strong><span>Deposit, auction, manage, check, settle</span></a>
                  <a className="menu__link" href="#tour"><strong>What the manager can do</strong><span>Two verbs: rebalance and setFee</span></a>
                  <a className="menu__link" href="#defences"><strong>The mispricing attack</strong><span>And the six guards that price it out</span></a>
                </div>
                <div className="menu__col"><p className="menu__label">For</p>
                  <a className="menu__link" href={APP}><strong>Treasuries</strong><span>Post a mandate: your tokens, your terms</span></a>
                  <a className="menu__link" href={APP}><strong>Market makers</strong><span>Bid a bond, run it clean, earn a share of fees</span></a>
                  <a className="menu__link" href="#facts"><strong>Keepers</strong><span>Anyone can checkpoint and settle</span></a>
                </div>
                <div className="menu__popular"><p className="menu__label">Start here</p>
                  <a className="menu__card" href={APP}><strong>Launch the app →</strong><span>Live on Unichain Sepolia</span></a>
                </div>
              </div>
            </div>
            <div className="menu__panel" id="menu-resources" role="region" aria-label="Resources">
              <p className="menu__heading">Resources</p>
              <div className="menu__cols">
                <div className="menu__col"><p className="menu__label">Read</p>
                  <a className="menu__link" href={REPO} target="_blank" rel="noopener noreferrer"><strong>Source on GitHub ↗</strong><span>Contracts, tests, keeper and this site</span></a>
                  <a className="menu__link" href={SOURCE} target="_blank" rel="noopener noreferrer"><strong>Leash.sol ↗</strong><span>The hook, in one file</span></a>
                  <a className="menu__link" href={`${REPO}#mandate-terms`} target="_blank" rel="noopener noreferrer"><strong>Mandate terms ↗</strong><span>Every number a treasury sets</span></a>
                </div>
                <div className="menu__col"><p className="menu__label">Verify</p>
                  <a className="menu__link" href={SCAN} target="_blank" rel="noopener noreferrer"><strong>Blockscout ↗</strong><span>The hook on Unichain Sepolia, source verified</span></a>
                  <a className="menu__link" href={`${REPO}#known-limits`} target="_blank" rel="noopener noreferrer"><strong>Known limits ↗</strong><span>What the hook does not protect against</span></a>
                </div>
                <div className="menu__popular"><p className="menu__label">Built for</p>
                  <a className="menu__card menu__card--dark" href={REPO} target="_blank" rel="noopener noreferrer"><strong>Uniswap Hook Incubator</strong><span>Cohort 11 hookathon</span></a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <canvas className="hero__canvas" aria-label="Illustration: a price line moving inside a manager's range. One epoch settles clean; in the next the average leaves the range and the bond is slashed." role="img" />
          <div className="hero__copy">
            <a className="hero__new rise" style={cv({ '--d': 0 })} href={SCAN} target="_blank" rel="noopener noreferrer"><b>Live</b> Unichain Sepolia, source verified →</a>
            <h1 className="display hero__title" id="hero-title">
              <span className="line"><span className="word" style={cv({ '--d': 1 })}>Keep</span></span>
              <span className="line"><span className="word" style={cv({ '--d': 2 })}>the</span></span>
              <span className="line"><span className="word" style={cv({ '--d': 3 })}>leash.</span></span>
            </h1>
            <p className="lede rise" style={cv({ '--d': 5 })}>Hire a market maker for your treasury without handing over the keys. They run the liquidity and set the fee. They can never withdraw it. A Uniswap v4 hook checks every swap, pays a clean epoch and slashes a breach.</p>
            <div className="actions rise" style={cv({ '--d': 6 })}>
              <a className="btn btn--primary" href={APP}>Launch app</a>
              <a className="btn btn--ghost" href="#story">How it works</a>
            </div>
          </div>
          <a className="cue rise" style={cv({ '--d': 8 })} href="#story">Scroll through one mandate</a>
        </section>

        <section className="story" id="story" aria-label="How a mandate runs">
          <div className="story__stage">
            <div className="story__text">
              <ol className="rail" aria-hidden="true"><li>Deposit</li><li>Auction</li><li>Manage</li><li>Checked</li><li>Settle</li></ol>
              <div className="steps">
                <article className="step is-active">
                  <p className="step__label">01 · Deposit</p>
                  <h2 className="display step__title">Tokens in. Keys kept.</h2>
                  <p>The treasury posts a mandate: its tokens and its terms. The hook creates the pool itself and places a permanent full-range anchor, so there is liquidity at every price. Nobody else can add any.</p>
                </article>
                <article className="step">
                  <p className="step__label">02 · Auction</p>
                  <h2 className="display step__title">Bid a bond to run it.</h2>
                  <p>Market makers bid a first-loss bond in the stablecoin. Each bid must beat the last, and an outbid bond is claimable at once. The highest bond when the auction ends holds the mandate.</p>
                </article>
                <article className="step">
                  <p className="step__label">03 · Manage</p>
                  <h2 className="display step__title">Two verbs. No withdraw.</h2>
                  <p>The manager moves the liquidity with rebalance and sets the fee between the floor and the cap. Neither takes an address. No function sends inventory to the manager.</p>
                </article>
                <article className="step">
                  <p className="step__label">04 · Every swap checked</p>
                  <h2 className="display step__title">Every swap reads the terms.</h2>
                  <p>Before each swap the hook records the price and checks the position against its own TWAP: in range, deep enough, on pace. The time since the last check is booked in or out of compliance.</p>
                </article>
                <article className="step">
                  <p className="step__label">05 · Settle</p>
                  <h2 className="display step__title">Clean pays. Breach slashes.</h2>
                  <p>When an epoch ends, anyone can settle it. Inside the uptime allowance, the manager earns a share of the epoch’s LP fees. Outside it, the whole bond goes to the treasury and the manager is fired.</p>
                </article>
              </div>
            </div>
            <canvas className="story__canvas" aria-hidden="true" />
          </div>
        </section>

        <section className="tour" id="tour" aria-labelledby="tour-title">
          <h2 className="display tour__title" id="tour-title" data-reveal>Run it.<br /> Never hold it.</h2>
          <div className="tour__grid">
            <div className="phone" data-screen="home" aria-hidden="true">
              <div className="phone__screen">
                <div className="screen screen--home">
                  <div className="screen__status"><b>9:41</b><span className="screen__bars"><i></i><i></i><i></i><i></i></span></div>
                  <div className="screen__body">
                    <div className="screen__account"><Mark size={30} /><span><b>TKN / USDC</b><small>Mandate · Unichain Sepolia</small></span></div>
                    <p className="screen__eyebrow">Epoch 3 of 4 · in compliance</p>
                    <p className="screen__balance">99.2<small>%</small></p>
                    <p className="screen__hint">Allowance 95% · settles in 2d 4h</p>
                    <svg className="screen__chart" viewBox="0 0 200 64" preserveAspectRatio="none">
                      <rect x="0" y="16" width="200" height="30" />
                      <path d="M0 34 L14 30 L28 33 L42 27 L56 31 L70 28 L84 35 L98 30 L112 26 L126 31 L140 29 L154 33 L168 28 L182 30 L200 27" />
                    </svg>
                    <dl className="screen__rows">
                      <div><dt>Bond</dt><dd className="is-bond">25,000 USDC</dd></div>
                      <div><dt>Fee</dt><dd>0.18% <small>cap 0.30%</small></dd></div>
                      <div><dt>Range</dt><dd>TWAP ± 600 ticks</dd></div>
                      <div><dt>Pace</dt><dd>24% USDC <small>≤ 27%</small></dd></div>
                      <div><dt>Track record</dt><dd>12 clean · 0 breached</dd></div>
                    </dl>
                    <p className="screen__head">Activity</p>
                    <ul className="screen__list">
                      <li><i className="is-good"></i><span><b>Epoch 2 settled clean</b><small>30% of fees to you</small></span><em>+1,322</em></li>
                      <li><i></i><span><b>Rebalanced</b><small>TWAP ± 600 ticks</small></span><em>2h</em></li>
                      <li><i></i><span><b>Fee set to 0.18%</b><small>floor 0.05 · cap 0.30</small></span><em>1d</em></li>
                    </ul>
                  </div>
                  <div className="screen__buttons"><span>Set fee</span><span className="is-go">Rebalance</span></div>
                </div>
                <div className="screen screen--send">
                  <div className="screen__status"><b>9:41</b><span className="screen__bars"><i></i><i></i><i></i><i></i></span></div>
                  <div className="screen__body">
                    <div className="screen__top"><em>←</em><span><small>Review</small><b>Rebalance</b></span></div>
                    <p className="screen__amount">±600 <small>ticks</small></p>
                    <p className="screen__to">around the TWAP, tick 2,041</p>
                    <dl className="screen__rows">
                      <div><dt>Spot vs TWAP</dt><dd>12 ticks <small>≤ 100</small></dd></div>
                      <div><dt>Liquidity</dt><dd>unchanged</dd></div>
                      <div><dt>Tokens move to</dt><dd>the pool, only</dd></div>
                      <div><dt>This block</dt><dd>first rebalance</dd></div>
                    </dl>
                    <p className="screen__note"><i></i>The hook refuses a range set while the price is pushed away from its average.</p>
                  </div>
                  <div className="screen__buttons"><span>Cancel</span><span className="is-go">Confirm</span></div>
                  <div className="screen__done"><span className="screen__check">✓</span><b>Rebalanced</b><small>Range centred on the TWAP. Nothing left the hook.</small></div>
                </div>
              </div>
            </div>
            <div className="tour__tiles">
              <article className="tile tile--mint" data-reveal>
                <h3>Bonds in the stablecoin. Outbid ones, claimable at once.</h3>
                <div className="tile__art tile__bids" aria-hidden="true"><span style={cv({ '--i': 0 })}>18,000</span><span style={cv({ '--i': 1 })}>22,500</span><span className="is-top" style={cv({ '--i': 2 })}>25,000 USDC</span></div>
              </article>
              <article className="tile tile--ink" data-reveal style={cv({ '--d': 1 })}>
                <h3>The manager sets the fee, inside the floor and the cap.</h3>
                <div className="tile__art tile__fee" aria-hidden="true"><i></i><b></b><span><em>floor</em><em>cap</em></span></div>
              </article>
              <article className="tile tile--violet" data-reveal style={cv({ '--d': 2 })}>
                <h3>Compliance is counted in seconds, not swaps.</h3>
                <div className="tile__art tile__clock" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <i key={i} className={i === 17 ? 'is-out' : ''} style={cv({ '--i': i })} />)}</div>
              </article>
              <article className="tile tile--line" data-reveal style={cv({ '--d': 3 })}>
                <h3>Every manager keeps a track record anyone can read.</h3>
                <div className="tile__art tile__record" aria-hidden="true"><span><b>12</b>clean</span><span><b>0</b>breached</span></div>
              </article>
            </div>
          </div>
        </section>

        <section className="defences" id="defences" aria-labelledby="defences-title">
          <div className="section-head" data-reveal>
            <h2 className="display section-title" id="defences-title">Withdrawal was never the risk.</h2>
            <p>A manager who wants to steal does it through the price: empty the pool, push the price with a tiny swap, put the treasury’s liquidity back around the fake price, then buy it cheap from another wallet. Nothing is withdrawn. Leash prices that out.</p>
          </div>
          <div className="attack" data-reveal>
            <ol className="attack__steps">
              <li>Pull the treasury’s liquidity out. The pool is nearly empty.</li>
              <li>Push the price down with a tiny swap. Cheap, with no liquidity there.</li>
              <li>Put the liquidity back around the fake low price.</li>
              <li>Buy the treasury’s tokens cheaply from another wallet.</li>
            </ol>
            <figure>
              <AttackChart />
              <figcaption><span>Fig. 1</span> Step 3, refused: one block of manipulation against a 30-block TWAP. Illustrative.</figcaption>
            </figure>
          </div>
          <div className="cards">
            {DEFENCES.map(([icon, title, body], i) => (
              <article className="card" key={title} data-reveal style={cv({ '--d': i % 3 })}>
                <svg className="card__icon" viewBox="0 0 88 88" aria-hidden="true">{ICONS[icon]}</svg>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="facts-wrap" id="facts" aria-labelledby="facts-title">
          <div className="facts__head" data-reveal>
            <h2 className="display facts__title" id="facts-title">Nothing to trust.</h2>
            <p>The hook enforces every term itself, on every swap, and pays or slashes without anyone’s say-so. Keepers checkpoint and settle; anyone can. These numbers come from the contract.</p>
          </div>
          <dl className="facts">
            <div data-reveal style={cv({ '--d': 0 })}><dt>verbs a manager has</dt><dd data-count="2">2</dd></div>
            <div data-reveal style={cv({ '--d': 1 })}><dt>functions that pay inventory to a manager</dt><dd data-count="0" data-from="9">0</dd></div>
            <div data-reveal style={cv({ '--d': 2 })}><dt>ticks a second, the most the oracle moves</dt><dd data-count="50">50</dd></div>
            <div data-reveal style={cv({ '--d': 3 })}><dt>most the position grows per TWAP window</dt><dd data-count="5" data-suffix="%">5%</dd></div>
          </dl>
        </section>

        <section className="proof" id="proof" aria-labelledby="proof-title">
          <div className="section-head" data-reveal>
            <h2 className="display section-title" id="proof-title">On chain, in the open.</h2>
            <p>Leash is live on Unichain Sepolia with its source verified. Read the contract, then read what it did.</p>
          </div>
          <div className="proof__grid">
            <article className="proof__card proof__card--pattern" data-reveal style={cv({ '--d': 0 })}>
              <h3>Live on Unichain Sepolia.</h3>
              <p className="proof__addr">{HOOK.slice(0, 6)}…{HOOK.slice(-4)}<small>Leash hook · source verified</small></p>
              <a className="round" href={SCAN} target="_blank" rel="noopener noreferrer" aria-label="Open the hook on Blockscout"><Arrow /></a>
            </article>
            <article className="proof__card proof__card--mint" data-reveal style={cv({ '--d': 1 })}>
              <h3>Audited, then audited again.</h3>
              <ul className="proof__audit">
                <li><b>Audit</b><span>2 critical, 1 high, 2 medium, 1 low found and fixed. Each attack kept as a regression test.</span></li>
                <li><b>Re-audit</b><span>1 high, 2 medium, 2 low found. Fixed, or bounded and documented.</span></li>
              </ul>
            </article>
            <article className="proof__card proof__card--ledger" data-reveal style={cv({ '--d': 2 })}>
              <h3>What every swap checks</h3>
              <div className="ledger">
                <div className="ledger__ring">
                  <svg viewBox="0 0 120 120" aria-hidden="true">
                    <circle className="ledger__track" cx="60" cy="60" r="50" />
                    {['var(--mint)', 'var(--soft)', 'var(--violet)', 'var(--cream)'].map((c, i) => (
                      <circle key={c} className="ledger__arc" cx="60" cy="60" r="50" style={cv({ '--c': c, '--i': i })} transform={`rotate(${4 + i * 90} 60 60)`} />
                    ))}
                  </svg>
                  <p><b data-count="4">4</b><small>terms</small></p>
                </div>
                <ul className="ledger__list">
                  <li style={cv({ '--c': 'var(--mint)' })}><b>In range</b><span>TWAP inside it</span></li>
                  <li style={cv({ '--c': 'var(--soft)' })}><b>Depth</b><span>at or over floor</span></li>
                  <li style={cv({ '--c': 'var(--violet)' })}><b>Pace</b><span>under glide path</span></li>
                  <li style={cv({ '--c': 'var(--cream)' })}><b>Fee</b><span>under cap, when set</span></li>
                </ul>
              </div>
            </article>
            <article className="proof__card proof__card--flow" data-reveal style={cv({ '--d': 3 })}>
              <h3>A mandate, the way the chain shows it.</h3>
              <div className="flow" aria-hidden="true">
                {FLOW.map((r, i) => (
                  <div className="flow__row" key={i}>{r.map((c) => { const [what, tag] = c.split('|'); return <span key={c}>{what} <em data-tag={tag}>{tag}</em></span>; })}</div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="final" id="final" aria-labelledby="final-title">
          <div className="final__panel">
            <div className="final__copy" data-reveal>
              <h2 className="display final__title" id="final-title">Hire them.<br /> Keep the leash.</h2>
              <div className="actions"><a className="btn btn--primary" href={APP}>Launch app</a></div>
              <p className="fine">Unichain Sepolia testnet. Test tokens have no value.</p>
            </div>
          </div>
        </section>

        <section className="duo" aria-label="Get started">
          <article className="duo__card duo__card--mint" data-reveal>
            <h2 className="display">Run a treasury?</h2>
            <p>Post a mandate: your tokens, your terms, and a bond auction for the right to run them. Only you can take the inventory out.</p>
            <a className="btn btn--dark" href={APP}>Post a mandate</a>
          </article>
          <article className="duo__card duo__card--dark" data-reveal style={cv({ '--d': 1 })}>
            <h2 className="display">Make markets?</h2>
            <p>Bid a bond for a mandate. Run it clean and earn a share of the fees, with a track record anyone can read.</p>
            <a className="btn btn--primary" href={APP}>Bid for a mandate</a>
          </article>
        </section>
      </main>

      <footer className="footer" id="footer">
        <div className="footer__top">
          <a className="brand footer__brand" href="./" aria-label="Leash, back to top"><Mark size={36} /><span>leash</span></a>
          <nav className="footer__cols" aria-label="Footer">
            <div><p className="footer__h">Protocol</p>
              <a href="#story">How a mandate runs</a>
              <a href="#tour">What a manager can do</a>
              <a href="#defences">The mispricing attack</a>
              <a href="#facts">The numbers</a>
            </div>
            <div><p className="footer__h">App</p>
              <a href={APP}>Launch app</a>
              <a href={APP}>Post a mandate</a>
              <a href={APP}>Bid for a mandate</a>
            </div>
            <div><p className="footer__h">Source</p>
              <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
              <a href={SOURCE} target="_blank" rel="noopener noreferrer">Leash.sol ↗</a>
              <a href={SCAN} target="_blank" rel="noopener noreferrer">Blockscout ↗</a>
            </div>
          </nav>
        </div>
        <div className="footer__bottom"><p>Built for the Uniswap Hook Incubator, cohort 11.</p><p>Live on Unichain Sepolia. Test tokens have no value.</p></div>
      </footer>
    </div>
  );
}
