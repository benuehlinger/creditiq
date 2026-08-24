import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import AppShell from './components/AppShell'
import { isPortfolioKey } from './lib/api'
import DataSurface from './surfaces/DataSurface'
import ExploreSurface from './surfaces/ExploreSurface'
import ModelSurface from './surfaces/ModelSurface'
import LgdSurface from './surfaces/LgdSurface'
import LgdExploreSurface from './surfaces/LgdExploreSurface'
import MacroSurface from './surfaces/MacroSurface'
import ScenarioSurface from './surfaces/ScenarioSurface'
import VersionsSurface from './surfaces/VersionsSurface'
import RollUpSurface from './surfaces/RollUpSurface'
import BrandSurface from './surfaces/BrandSurface'

/** Portfolio context lives in the URL, so any screen is linkable and the
 *  presenter can jump straight to it mid-demo. */
/** Sends an unknown portfolio key to the roll-up instead of rendering an empty
 *  surface. `<Outlet/>` when the key is real, so every child route is unchanged. */
function KnownPortfolio() {
  const { portfolio } = useParams()
  return isPortfolioKey(portfolio) ? <Outlet /> : <Navigate to="/rollup" replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* `/:portfolio` matches ANY string, so a stale bookmark or a typo used
            to render a surface with no data and no explanation. Every portfolio
            route passes through this guard first. */}
        <Route path="/" element={<Navigate to="/rollup" replace />} />
        <Route path="/rollup" element={<RollUpSurface />} />
        <Route path="/brand" element={<BrandSurface />} />
        <Route path="/:portfolio" element={<KnownPortfolio />}>
          <Route path="data" element={<DataSurface />} />
          <Route path="macro" element={<MacroSurface />} />
          {/* Each model has an Explore stage and a Fit stage. */}
          <Route path="pd/explore" element={<ExploreSurface />} />
          <Route path="pd/fit" element={<ModelSurface />} />
          <Route path="pd/fit/:version" element={<ModelSurface />} />
          <Route path="lgd/explore" element={<LgdExploreSurface />} />
          <Route path="lgd/fit" element={<LgdSurface />} />
          <Route path="scenarios" element={<ScenarioSurface />} />
          <Route path="versions" element={<VersionsSurface />} />
          {/* Paths from before the surfaces were grouped by model. */}
          <Route path="explore" element={<Navigate to="../pd/explore" replace />} />
          <Route path="model" element={<Navigate to="../pd/fit" replace />} />
          <Route path="pd" element={<Navigate to="explore" replace />} />
          <Route path="lgd" element={<Navigate to="explore" replace />} />
          <Route index element={<Navigate to="data" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/rollup" replace />} />
      </Route>
    </Routes>
  )
}
