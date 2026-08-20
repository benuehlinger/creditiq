import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import DataSurface from './surfaces/DataSurface'
import ExploreSurface from './surfaces/ExploreSurface'
import ModelSurface from './surfaces/ModelSurface'
import ScenarioSurface from './surfaces/ScenarioSurface'
import VersionsSurface from './surfaces/VersionsSurface'
import RollUpSurface from './surfaces/RollUpSurface'

/** Portfolio context lives in the URL, so any screen is linkable and the
 *  presenter can jump straight to it mid-demo. */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/rollup" replace />} />
        <Route path="/rollup" element={<RollUpSurface />} />
        <Route path="/:portfolio/data" element={<DataSurface />} />
        <Route path="/:portfolio/explore" element={<ExploreSurface />} />
        <Route path="/:portfolio/model" element={<ModelSurface />} />
        <Route path="/:portfolio/model/:version" element={<ModelSurface />} />
        <Route path="/:portfolio/scenarios" element={<ScenarioSurface />} />
        <Route path="/:portfolio/versions" element={<VersionsSurface />} />
        <Route path="/:portfolio" element={<Navigate to="data" replace />} />
        <Route path="*" element={<Navigate to="/rollup" replace />} />
      </Route>
    </Routes>
  )
}
