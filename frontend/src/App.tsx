import { AttackChart } from './AttackChart';
import { LeashScene } from './LeashScene';

const REPO = 'https://github.com/minrawsjar/Leash';

// [clause, term, value, how the hook enforces it, built yet?]
const TERMS: [string, string, string, string, boolean][] = [
  ['1.1', 'Inventory', '2,000,000 TKN + 400,000 USDC', 'Deposited into the hook. Only the treasury can take it out.', true],
  ['1.2', 'Bond', 'at least 25,000 USDC', 'Highest bond when the auction closes wins. Lost on a breach.', true],
  ['1.3', 'Fee', 'at most 0.30%', 'setFee() refuses anything higher.', true],
  ['1.4', 'Withdrawal by the manager', 'not possible', 'There is no function for it.', true],
  ['1.5', 'Term', '4 epochs of 7 days', 'Each epoch is settled on its own.', false],
  ['1.6', 'Placement', 'within 1% of the TWAP', 'rebalance() refuses ranges set off a pushed price.', false],
  ['1.7', 'Depth', '$50,000 to move price 2%', 'Measured on every swap.', false],
  ['1.8', 'Pace', 'USDC share ≤ 17% → 40%', 'Measured on every swap. Selling ahead of the line is dumping.', false],
  ['1.9', 'Uptime', '95% of each epoch', 'Counted in seconds, so one bad block breaches nothing.', false],
];

const STEPS: [string, string][] = [
  ['Posting.', 'The treasury calls createMandate() with the terms and its tokens. The hook creates the pool itself, and nobody else can add liquidity to it, so the pool’s book is exactly the treasury’s position.'],
  ['Auction.', 'Managers bid a bond in USDC. Each bid has to beat the last, and an outbid bond can be claimed back at once. When the auction closes, the highest bidder holds the mandate.'],
  ['Management.', 'The manager gets two levers: rebalance(), which moves the liquidity to a new range, and setFee(). Neither takes an address. Tokens only travel between the hook and the pool.'],
  ['Inspection.', 'Before every swap the hook records the price and checks the position: in range, deep enough, on pace. The seconds since the last swap go on the epoch’s record as in or out of compliance.'],
  ['Settlement.', 'When an epoch ends anyone can settle it. Inside the allowance, the manager takes 30% of the fees the position earned. Outside it, the bond goes to the treasury. After the last epoch the treasury closes the mandate and takes everything back.'],
];

// Illustrative record: pay is 30% of fees; the allowance is 95% uptime.
const EPOCHS = [
  { n: 1, up: 99.4, fees: '3,912', outcome: '1,174 USDC to the manager', ok: true },
  { n: 2, up: 98.1, fees: '4,406', outcome: '1,322 USDC to the manager', ok: true },
  { n: 3, up: 91.7, fees: '2,980', outcome: '25,000 USDC bond to the treasury', ok: false },
];
const FLOOR = 80; // the uptime bars start at 80% so the 95% line is readable

export function App() {
  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-top">
          <a className="wordmark" href="#">Leash</a>
          <nav aria-label="Sections">
            <a href="#terms">Terms</a>
            <a href="#runs">How it runs</a>
            <a href="#attack">The attack</a>
            <a href="#ledger">Ledger</a>
            <a href={REPO}>Source ↗</a>
          </nav>
        </div>
        <div className="masthead-meta mono">
          <span>A Uniswap v4 hook for treasury market making</span>
          <span>Unichain Sepolia · in development</span>
        </div>
      </header>

      <main>
        <section className="hero">
          <h1><span>Hire a market maker.</span> <em>Keep the <span className="red">leash</span>.</em></h1>
          <div className="hero-body">
            <div className="deck">
              <p>
                Leash is a Uniswap v4 hook that holds a treasury’s tokens and lets a hired market maker run them. The
                manager posts a bond, moves the liquidity and sets the fee. The hook checks every swap. The manager never
                gets custody.
              </p>
              <p className="aside">
                Token treasuries usually choose between dumping on the market, selling OTC at a discount, or handing their
                inventory to a market maker they have to trust. Leash is a fourth option: sell only into real demand, at a
                pace you set, without giving anyone the keys.
              </p>
              <p className="mono small">Built for the Uniswap Hook Incubator, cohort 11. Not audited.</p>
            </div>
            <LeashScene />
          </div>
        </section>

        <section id="terms">
          <h2><span className="sec mono">§1</span>The terms</h2>
          <p className="intro">
            A mandate is a short list of numbers. Here is an example. Every term is enforced by the hook itself, at the
            point named on the right.
          </p>
          <table className="terms">
            <thead>
              <tr className="mono"><th>Clause</th><th>Term</th><th>Value</th><th>Enforced by</th><th>Status</th></tr>
            </thead>
            <tbody>
              {TERMS.map(([n, term, value, how, live]) => (
                <tr key={n}>
                  <td className="mono num">{n}</td>
                  <td className="term">{term}</td>
                  <td className="mono value">{value}</td>
                  <td className="how">{how}</td>
                  <td className={`mono status ${live ? '' : 'pending'}`}>{live ? 'Built' : 'Building'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="runs">
          <h2><span className="sec mono">§2</span>How a mandate runs</h2>
          <div className="columns">
            {STEPS.map(([head, body], i) => (
              <p key={head}><span className="mono run">2.{i + 1}</span> <b>{head}</b> {body}</p>
            ))}
          </div>
        </section>

        <section id="attack" className="attack">
          <h2><span className="sec mono">§3</span>Withdrawal was never the risk</h2>
          <div className="attack-body">
            <div>
              <p>
                Stopping a manager from withdrawing takes one missing function. The real risk is price. With the treasury
                as the only liquidity in the pool, a manager could:
              </p>
              <ol>
                <li>pull the liquidity, leaving the pool empty;</li>
                <li>push the price down with a small swap;</li>
                <li>put the liquidity back around the fake price;</li>
                <li>buy the treasury’s tokens cheaply from another wallet.</li>
              </ol>
              <p>
                Nothing is withdrawn and the treasury still loses. So Leash keeps its own time-weighted average price,
                recorded once per block before the first swap. A price pushed for one block barely moves it, and
                rebalance() refuses any range set while the price is far from the average.
              </p>
            </div>
            <figure>
              <AttackChart />
              <figcaption><span className="mono">Fig. 1</span> One block of manipulation against a 30-block TWAP. Illustrative.</figcaption>
            </figure>
          </div>
        </section>

        <section id="ledger">
          <h2><span className="sec mono">§4</span>The ledger</h2>
          <p className="intro">
            Each epoch is judged on time, not on single swaps. An example record, with the uptime allowance set at 95%:
          </p>
          <table className="ledger">
            <thead>
              <tr className="mono"><th>Epoch</th><th>Time in compliance</th><th>Swap fees</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {EPOCHS.map((e) => (
                <tr key={e.n}>
                  <td className="mono num">{e.n}</td>
                  <td>
                    <div className="uptime">
                      <div className="bar" style={{ width: `${((e.up - FLOOR) / (100 - FLOOR)) * 100}%` }} data-ok={e.ok || undefined} />
                      <div className="line" style={{ left: `${((95 - FLOOR) / (100 - FLOOR)) * 100}%` }} />
                    </div>
                    <span className="mono small">{e.up.toFixed(1)}%</span>
                  </td>
                  <td className="mono value">{e.fees} USDC</td>
                  <td className="outcome">
                    <span className={`stamp mono ${e.ok ? '' : 'red'}`}>{e.ok ? 'Paid' : 'Slashed'}</span>
                    {e.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mono small note">Bars run from 80% to 100%. The rule marks the 95% allowance.</p>
        </section>

        <section className="signed">
          <h2 className="mono">Signed</h2>
          <div className="sigs">
            <div><span className="sig-line" />The treasury</div>
            <div><span className="sig-line" />The manager</div>
            <div><span className="sig-line hook">Leash.sol</span>The hook, which reads the terms on every swap</div>
          </div>
        </section>
      </main>

      <footer className="mono small">
        <span>Leash · Uniswap Hook Incubator, cohort 11</span>
        <a href={REPO}>github.com/minrawsjar/Leash</a>
        <span>Not audited. Not for real funds yet.</span>
      </footer>
    </div>
  );
}
