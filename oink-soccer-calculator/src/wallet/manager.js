import { NetworkId, WalletManager } from '@txnlab/use-wallet-react';
import { defly } from '@txnlab/use-wallet-defly';
import { kibisis } from '@txnlab/use-wallet-kibisis';
import { pera } from '@txnlab/use-wallet-pera';

export const walletManager = new WalletManager({
  wallets: [pera(), defly(), kibisis()],
  defaultNetwork: NetworkId.MAINNET,
});
