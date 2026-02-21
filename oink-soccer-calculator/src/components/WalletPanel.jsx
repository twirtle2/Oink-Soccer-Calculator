import React, { useMemo, useState } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';

const shortenAddress = (address) => {
  if (!address || address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
};

export default function WalletPanel({ onSync, isSyncing, syncMeta }) {
  const { wallets } = useWallet();
  const [error, setError] = useState(null);

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

  return (
    <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Wallet size={16} className="text-green-400" />
          Wallet Assets (MainNet)
        </h3>
        <button
          onClick={onSync}
          disabled={!canSync}
          className={`px-3 py-1.5 text-xs rounded-lg font-bold flex items-center gap-2 transition-colors ${
            canSync ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-slate-700 text-slate-500 cursor-not-allowed'
          }`}
        >
          <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
          {isSyncing ? 'Syncing...' : 'Sync Playable Assets'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {wallets.map((wallet) => (
          <div key={wallet.walletKey} className="border border-slate-700 rounded-lg p-3 bg-slate-900/40">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-300">{wallet.metadata.name}</span>
              {wallet.isConnected && <span className="text-[10px] text-green-400 font-bold">CONNECTED</span>}
            </div>
            <div className="text-[10px] text-slate-500 mb-3">
              {wallet.accounts.length > 0 ? `${wallet.accounts.length} account(s)` : 'No accounts'}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => handleConnect(wallet)}
                disabled={wallet.isConnected}
                className={`flex-1 text-[10px] font-bold py-1 rounded ${
                  wallet.isConnected ? 'bg-slate-700 text-slate-500' : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                Connect
              </button>
              <button
                onClick={() => handleDisconnect(wallet)}
                disabled={!wallet.isConnected}
                className={`flex-1 text-[10px] font-bold py-1 rounded ${
                  !wallet.isConnected ? 'bg-slate-700 text-slate-500' : 'bg-slate-600 hover:bg-slate-500 text-white'
                }`}
              >
                Disconnect
              </button>
            </div>
          </div>
        ))}
      </div>

      {connectedAddresses.length > 0 ? (
        <div className="text-xs text-slate-400 bg-slate-900/40 border border-slate-700 rounded-lg p-3">
          <div className="font-bold text-slate-300 mb-1">Connected Accounts</div>
          <div className="flex flex-wrap gap-2">
            {connectedAddresses.map((address) => (
              <span key={address} className="px-2 py-1 rounded bg-slate-700 text-slate-200 font-mono text-[10px]">
                {shortenAddress(address)}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-xs text-yellow-300 bg-yellow-900/20 border border-yellow-600/30 rounded-lg p-3">
          Connect a wallet to sync playable assets into your squad.
        </div>
      )}

      <div className="text-xs text-slate-400 grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-2">
          <span className="text-slate-500 block text-[10px] uppercase">Last Sync</span>
          <span>{syncMeta?.lastSyncedAt ? new Date(syncMeta.lastSyncedAt).toLocaleString() : 'Never'}</span>
        </div>
        <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-2">
          <span className="text-slate-500 block text-[10px] uppercase">Playable Matched</span>
          <span>{syncMeta?.matchedCount ?? 0}</span>
        </div>
        <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-2">
          <span className="text-slate-500 block text-[10px] uppercase">Holdings Ignored</span>
          <span>{syncMeta?.unmatchedCount ?? 0}</span>
        </div>
      </div>

      {(error || syncMeta?.lastError) && (
        <div className="text-xs text-red-300 bg-red-900/20 border border-red-700/40 rounded-lg p-2">
          {error || syncMeta.lastError}
        </div>
      )}
    </div>
  );
}
