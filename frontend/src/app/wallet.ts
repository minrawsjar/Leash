// The injected wallet (window.ethereum): connect, follow account/chain changes, switch networks, and hand
// actions.ts a viem wallet client on the right chain.
import { useEffect, useState } from 'react';
import { createWalletClient, custom, getAddress, numberToHex, type Address, type EIP1193Provider } from 'viem';
import { client, viemChain, type Net } from './chain.ts';
import type { Ctx } from './actions.ts';

declare global { interface Window { ethereum?: EIP1193Provider } }

export type Wallet = { account: Address | null; chainId: number | null; connect: () => Promise<void>; disconnect: () => void; ctx: (n: Net) => Promise<Ctx> };

// Injected wallets have no standard "disconnect": eth_accounts keeps returning the account to a site it trusts. So the
// app remembers a disconnect itself (and asks the wallet to revoke where it can) until the person connects again.
const OFF = 'leash.disconnected';
const isOff = () => { try { return localStorage.getItem(OFF) === '1'; } catch { return false; } };
const setOff = (v: boolean) => { try { if (v) localStorage.setItem(OFF, '1'); else localStorage.removeItem(OFF); } catch { /* private mode */ } };

export function useWallet(): Wallet {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const eth = typeof window !== 'undefined' ? window.ethereum : undefined;

  useEffect(() => {
    if (!eth) return;
    const onAcc = (a: string[]) => setAccount(a[0] && !isOff() ? getAddress(a[0]) : null);
    const onChain = (c: string) => setChainId(Number(c));
    eth.request({ method: 'eth_accounts' }).then(onAcc).catch(() => {});
    eth.request({ method: 'eth_chainId' }).then(onChain).catch(() => {});
    eth.on('accountsChanged', onAcc);
    eth.on('chainChanged', onChain);
    return () => { eth.removeListener('accountsChanged', onAcc); eth.removeListener('chainChanged', onChain); };
  }, [eth]);

  async function connect() {
    if (!eth) throw new Error('No browser wallet found. Install one (MetaMask, Rabby, …) to sign transactions.');
    const a = await eth.request({ method: 'eth_requestAccounts' });
    setOff(false);
    setAccount(a[0] ? getAddress(a[0]) : null);
  }

  function disconnect() {
    setOff(true);
    setAccount(null);
    // MetaMask and others that implement EIP-2255 drop the site's access too; elsewhere this is a no-op.
    eth?.request({ method: 'wallet_revokePermissions' as never, params: [{ eth_accounts: {} }] as never }).catch(() => {});
  }

  async function ctx(n: Net): Promise<Ctx> {
    if (!eth) throw new Error('No browser wallet found. Install one (MetaMask, Rabby, …) to sign transactions.');
    let acc = account;
    if (!acc) { const a = await eth.request({ method: 'eth_requestAccounts' }); acc = getAddress(a[0]); setOff(false); setAccount(acc); }
    const current = Number(await eth.request({ method: 'eth_chainId' }));
    if (current !== n.id) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(n.id) }] });
      } catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await eth.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: numberToHex(n.id), chainName: n.name, rpcUrls: [n.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          ...(n.explorer ? { blockExplorerUrls: [n.explorer] } : {}),
        }] });
      }
    }
    const wallet = createWalletClient({ account: acc, chain: viemChain(n), transport: custom(eth) });
    return { pub: client(n), wallet, account: acc, leash: n.dep.leash };
  }

  return { account, chainId, connect, disconnect, ctx };
}
