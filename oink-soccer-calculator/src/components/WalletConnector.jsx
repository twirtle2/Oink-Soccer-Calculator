import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Wallet } from 'lucide-react';
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
  const buttonLabel = connectedAddresses.length > 0 ? `Connect (${connectedAddresses.length})` : 'Connect';

  return (
    <div className="relative z-50" ref={popoverRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm font-bold text-white shadow-glow transition hover:border-green-400/60 hover:bg-slate-800"
      >
        <Wallet size={14} className="text-green-400" />
        {buttonLabel}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-w-[90vw] rounded-2xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-white">Wallet Connector</h3>
              <p className="text-[11px] text-slate-400">
                Connect multiple wallets. Playable assets from all connected wallets are included.
              </p>
            </div>
            <button
              onClick={onSync}
              disabled={!canSync}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                canSync ? 'bg-green-600 text-white hover:bg-green-500' : 'bg-slate-700 text-slate-500'
              }`}
            >
              <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
              {isSyncing ? 'Syncing' : 'Sync'}
            </button>
          </div>

          <div className="space-y-2">
            {wallets.map((wallet) => (
              <div key={wallet.walletKey} className="rounded-lg border border-slate-700 bg-slate-800/40 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200">{wallet.metadata.name}</span>
                  {wallet.isConnected && <span className="text-[10px] font-bold text-green-400">CONNECTED</span>}
                </div>
                <div className="mb-2 text-[10px] text-slate-400">
                  {wallet.accounts.length > 0 ? `${wallet.accounts.length} account(s)` : 'No accounts'}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleConnect(wallet)}
                    disabled={wallet.isConnected}
                    className={`flex-1 rounded py-1 text-[10px] font-bold ${
                      wallet.isConnected ? 'bg-slate-700 text-slate-500' : 'bg-blue-600 text-white hover:bg-blue-500'
                    }`}
                  >
                    Connect
                  </button>
                  <button
                    onClick={() => handleDisconnect(wallet)}
                    disabled={!wallet.isConnected}
                    className={`flex-1 rounded py-1 text-[10px] font-bold ${
                      wallet.isConnected ? 'bg-slate-600 text-white hover:bg-slate-500' : 'bg-slate-700 text-slate-500'
                    }`}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-lg border border-slate-700 bg-slate-800/40 p-2">
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

          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-300">
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
            <div className="mt-2 rounded border border-red-700/40 bg-red-900/20 p-2 text-[11px] text-red-300">
              {error || syncMeta.lastError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
