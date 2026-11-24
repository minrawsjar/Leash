// The injected wallet (window.ethereum): connect, follow account/chain changes, switch networks, and hand
// actions.ts a viem wallet client on the right chain.
import { useEffect, useState } from 'react';
import { createWalletClient, custom, getAddress, numberToHex, type Address, type EIP1193Provider } from 'viem';
import { client, viemChain, type Net } from './chain.ts';
import type { Ctx } from './actions.ts';

declare global { interface Window { ethereum?: EIP1193Provider } }

export type Wallet = { account: Address | null; chainId: number | null; connect: () => Promise<void>; ctx: (n: Net) => Promise<Ctx> };

export function useWallet(): Wallet {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const eth = typeof window !== 'undefined' ? window.ethereum : undefined;

  useEffect(() => {
    if (!eth) return;
    const onAcc = (a: string[]) => setAccount(a[0] ? getAddress(a[0]) : null);
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
    setAccount(a[0] ? getAddress(a[0]) : null);
  }

  async function ctx(n: Net): Promise<Ctx> {
    if (!eth) throw new Error('No browser wallet found. Install one (MetaMask, Rabby, …) to sign transactions.');
    let acc = account;
    if (!acc) { const a = await eth.request({ method: 'eth_requestAccounts' }); acc = getAddress(a[0]); setAccount(acc); }
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

  return { account, chainId, connect, ctx };
}
