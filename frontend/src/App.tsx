import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import AppShell from './components/AppShell'
import { isPortfolioKey } from './lib/api'
import DataSurface from './surfaces/DataSurface'
import PdWorkbench from './surfaces/PdWorkbench'
import LgdWorkbench from './surfaces/LgdWorkbench'
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
          {/* One workbench per model. The old Explore and Fit stages are kept
              as redirects so a saved link still lands somewhere. */}
          <Route path="pd" element={<PdWorkbench />} />
          <Route path="pd/explore" element={<Navigate to="../pd" replace />} />
          <Route path="pd/fit" element={<Navigate to="../pd" replace />} />
          <Route path="pd/fit/:version" element={<Navigate to="../pd" replace />} />
          <Route path="lgd" element={<LgdWorkbench />} />
          <Route path="lgd/explore" element={<Navigate to="../lgd" replace />} />
          <Route path="lgd/fit" element={<Navigate to="../lgd" replace />} />
          <Route path="scenarios" element={<ScenarioSurface />} />
          <Route path="versions" element={<VersionsSurface />} />
          {/* Paths from before the surfaces were grouped by model. */}
          <Route path="explore" element={<Navigate to="../pd" replace />} />
          <Route path="model" element={<Navigate to="../pd" replace />} />
          <Route index element={<Navigate to="data" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/rollup" replace />} />
      </Route>
    </Routes>
  )
}
