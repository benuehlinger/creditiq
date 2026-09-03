import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { applyStoredTheme } from './lib/store'
import './design/theme.css'

applyStoredTheme()

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // The panels do not change while the app runs, so nothing needs refetching
      // on focus. This also keeps a live demo from flickering when the presenter
      // alt-tabs to their notes.
      staleTime: Infinity,
      // An hour, not the five-minute default: leaving a surface for six
      // minutes and coming back showed the skeleton again for data that could
      // not have changed. The data-fingerprint watchdog reloads the app when
      // the data DOES change, which is what makes holding results this long
      // safe.
      gcTime: 60 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
