import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WalletProvider } from '@txnlab/use-wallet-react'
import './index.css'
import App from './App.jsx'
import { walletManager } from './wallet/manager'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WalletProvider manager={walletManager}>
      <App />
    </WalletProvider>
  </StrictMode>,
)
