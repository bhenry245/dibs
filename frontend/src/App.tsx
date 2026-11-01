import { Route, Routes } from 'react-router'
import CreateBillPage from './pages/CreateBillPage.tsx'
import ShareBillPage from './pages/ShareBillPage.tsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<CreateBillPage />} />
      <Route path="/bills/:shareCode/share" element={<ShareBillPage />} />
    </Routes>
  )
}

export default App
