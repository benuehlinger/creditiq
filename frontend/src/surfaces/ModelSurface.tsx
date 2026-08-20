import { useParams } from 'react-router-dom'
import { Card, CardHead, EmptyState } from '../components/ui'

/** Placeholder. Filled in the slice that owns this surface — the app stays
 *  runnable at every commit rather than breaking while a surface is built. */
export default function ModelSurface() {
  const { portfolio = 'consumer' } = useParams()
  return (
    <div className="p-4">
      <Card>
        <CardHead title="Model" subtitle={portfolio} />
        <EmptyState title="Not built yet">
          This surface is scheduled in a later slice. The Data surface is live —
          use the portfolio switcher or press 1.
        </EmptyState>
      </Card>
    </div>
  )
}
