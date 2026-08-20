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
