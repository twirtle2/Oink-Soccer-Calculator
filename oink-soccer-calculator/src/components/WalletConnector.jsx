import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, PlusCircle, RefreshCw, Wallet } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';

const shortenAddress = (address) => {
  if (!address || address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
};

export default function WalletConnector({ onSync, isSyncing, syncMeta }) {
  const { wallets } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const popoverRef = useRef(null);

  const connectedWallets = useMemo(
    () => wallets.filter((wallet) => wallet.isConnected),
    [wallets],
  );

  const connectedAddresses = useMemo(() => {
    const addresses = new Set();
    for (const wallet of connectedWallets) {
      for (const account of wallet.accounts) {
        addresses.add(account.address);
      }
    }
    return Array.from(addresses);
  }, [connectedWallets]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleConnect = async (wallet) => {
    setError(null);
    try {
      await wallet.connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  };

  const handleDisconnect = async (wallet) => {
    setError(null);
    try {
      await wallet.disconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect wallet');
    }
  };

  const canSync = connectedAddresses.length > 0 && !isSyncing;
  const buttonLabel = 'Connect Wallet';

  return (
    <div className="relative z-50" ref={popoverRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-2 rounded-2xl border-2 border-slate-200/80 bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow-glow transition hover:border-green-300"
      >
        <Wallet size={16} className="text-slate-100" />
        {buttonLabel}
        {connectedAddresses.length > 0 && (
          <span className="rounded-full bg-green-500/20 px-1.5 py-0.5 text-[10px] font-black text-green-300">
            {connectedAddresses.length}
          </span>
        )}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[520px] max-w-[95vw] overflow-hidden rounded-2xl border border-slate-300/60 bg-slate-100 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-3">
            <div className="text-base font-black text-slate-800">Connect Wallet</div>
            <button
              onClick={onSync}
              disabled={!canSync}
              className={`inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-bold ${
                canSync ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-slate-200 text-slate-500'
              }`}
            >
              <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
              {isSyncing ? 'Syncing' : 'Sync'}
            </button>
          </div>

          <div>
            {wallets.map((wallet) => (
              <div key={wallet.walletKey} className="flex items-center justify-between border-b border-slate-300 bg-slate-100 px-4 py-4">
                <div className="flex items-center gap-3">
                  {wallet.metadata.icon ? (
                    <img
                      src={wallet.metadata.icon}
                      alt={wallet.metadata.name}
                      className="h-10 w-10 rounded-full border border-slate-300 bg-white p-1.5"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white">
                      <Wallet size={16} className="text-slate-500" />
                    </div>
                  )}
                  <div>
                    <div className="text-2xl font-semibold leading-tight text-slate-700">{wallet.metadata.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {wallet.accounts.length > 0 ? `${wallet.accounts.length} account(s)` : 'No accounts'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleConnect(wallet)}
                    disabled={wallet.isConnected}
                    className={`inline-flex min-w-[130px] items-center justify-center gap-2 rounded-xl border px-4 py-2 text-base font-bold ${
                      wallet.isConnected
                        ? 'border-slate-300 bg-slate-200 text-slate-500'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <PlusCircle size={18} className={wallet.isConnected ? 'text-slate-400' : 'text-green-500'} />
                    {wallet.isConnected ? 'Connected' : 'Connect'}
                  </button>
                  {wallet.isConnected && (
                    <button
                      onClick={() => handleDisconnect(wallet)}
                      className="rounded-xl border border-slate-300 bg-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-300"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2 bg-slate-900 px-4 py-3">
            <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Connected Accounts</div>
              {connectedAddresses.length === 0 ? (
                <div className="text-[11px] text-slate-400">No wallet connected.</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {connectedAddresses.map((address) => (
                    <span key={address} className="rounded bg-slate-700 px-2 py-1 font-mono text-[10px] text-slate-200">
                      {shortenAddress(address)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-300">
              <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                <div className="text-[10px] uppercase text-slate-500">Last Sync</div>
                <div>{syncMeta?.lastSyncedAt ? new Date(syncMeta.lastSyncedAt).toLocaleTimeString() : 'Never'}</div>
              </div>
              <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                <div className="text-[10px] uppercase text-slate-500">Matched</div>
                <div>{syncMeta?.matchedCount ?? 0}</div>
              </div>
              <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                <div className="text-[10px] uppercase text-slate-500">Ignored</div>
                <div>{syncMeta?.unmatchedCount ?? 0}</div>
              </div>
            </div>

            {(error || syncMeta?.lastError) && (
              <div className="rounded border border-red-700/40 bg-red-900/20 p-2 text-[11px] text-red-300">
                {error || syncMeta.lastError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
