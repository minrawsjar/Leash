import { LeashScene } from './LeashScene';

const REPO = 'https://github.com/minrawsjar/Leash';

const STEPS = [
  ['Post a mandate', 'The treasury deposits token and stablecoin into the hook and sets the rules: target mix, minimum depth, fee cap, epochs.'],
  ['Managers bid a bond', 'Market makers compete by posting a first-loss bond. The highest bond wins the mandate; outbid bonds are claimable straight away.'],
  ["Steer, don't hold", 'The hook owns the liquidity. The manager moves ranges and sets fees inside the caps. Funds never leave the hook.'],
  ['Every swap is checked', "In range, deep enough, on pace, measured on a TWAP so one swap can't fake it. A clean epoch pays the manager; a breach slashes the bond to the treasury."],
];

const CAN = [
  ['Move liquidity', 'between ranges, as often as the market needs.'],
  ['Set the swap fee', "up to the treasury's cap."],
  ['Earn', 'a cut of swap fees for every clean epoch, plus an onchain track record.'],
];

const STOPS = [
  ['Withdrawals.', 'No function sends inventory to the manager.'],
  ['Off-market ranges.', 'Liquidity must sit near the TWAP, not a price pushed for one block.'],
  ['Fee gouging.', "The fee can never exceed the mandate's cap."],
  ['Outside LPs.', "The pool is the treasury's book alone, so depth and mix are measured exactly."],
];

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="var(--leash)" strokeWidth="3.5" />
      <path d="M13 13 Q 17 25 26 24" fill="none" stroke="var(--leash)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="26.5" cy="24" r="3.2" fill="var(--gold)" />
    </svg>
  );
}

const Rule = ({ items }: { items: string[][] }) => (
  <ul>{items.map(([b, rest]) => <li key={b}><span><b>{b}</b> {rest}</span></li>)}</ul>
);

export function App() {
  return (
    <div className="wrap">
      <header>
        <a className="brand" href="#"><Logo />Leash</a>
        <nav aria-label="Main">
          <a className="hide-sm" href="#how">How it works</a>
          <a className="hide-sm" href="#rules">The leash</a>
          <a href={REPO}>GitHub</a>
          <span className="btn" aria-disabled="true" title="The app opens once the hook is live on Unichain Sepolia">App · soon</span>
        </nav>
      </header>

      <main>
        <div className="hero">
          <div>
            <div className="eyebrow mono">Uniswap v4 hook · Unichain</div>
            <h1>Hire a market maker. <em>Keep the leash.</em></h1>
            <p className="lede">
              Token treasuries deposit inventory into a Uniswap v4 hook and post a mandate. Managers compete with a bond to
              run it. They move ranges and set fees, but they can never withdraw. Every swap is checked against the rules.
            </p>
            <div className="ctas">
              <a className="btn primary" href="#how">How it works</a>
              <a className="btn" href={REPO}>View the code</a>
            </div>
          </div>
          <LeashScene />
        </div>

        <section id="how">
          <h2>How it works</h2>
          <p className="sub">
            Market making and treasury diversification become the same trade. The treasury sells only into real buy demand,
            at its own pace. No OTC dumps, no custody handover.
          </p>
          <div className="steps">
            {STEPS.map(([title, body]) => <div className="card" key={title}><h3>{title}</h3><p>{body}</p></div>)}
          </div>
        </section>

        <section id="rules">
          <h2>The leash</h2>
          <p className="sub">
            Withdrawing is the easy attack to block. The real one is mispricing: moving the price, then trading against the
            treasury's own liquidity. Leash prices every move against a time-weighted average.
          </p>
          <div className="rules">
            <div className="card free">
              <h3>
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="var(--gold)" />
                  <path d="M7 12.5l3.2 3L17 9" fill="none" stroke="#1a1206" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                The manager can
              </h3>
              <Rule items={CAN} />
            </div>
            <div className="card held">
              <h3>
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="var(--leash)" />
                  <rect x="8" y="11" width="8" height="6" rx="1.2" fill="#1a0705" />
                  <path d="M9.5 11V9.5a2.5 2.5 0 0 1 5 0V11" fill="none" stroke="#1a0705" strokeWidth="1.8" />
                </svg>
                The leash stops
              </h3>
              <Rule items={STOPS} />
            </div>
          </div>
        </section>

        <section>
          <p className="quote">A market maker you never have to trust with the keys. <span>Free to make markets. Not free to run.</span></p>
        </section>
      </main>

      <footer>
        <span>Leash · Uniswap Hook Incubator, cohort 11</span>
        <span className="mono">Built on Uniswap v4 · Unichain Sepolia</span>
      </footer>
    </div>
  );
}
