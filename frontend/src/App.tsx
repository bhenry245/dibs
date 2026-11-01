import { Route, Routes } from 'react-router'
import BillPage from './pages/BillPage.tsx'
import CreateBillPage from './pages/CreateBillPage.tsx'
import ReviewBillPage from './pages/ReviewBillPage.tsx'
import ShareBillPage from './pages/ShareBillPage.tsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<CreateBillPage />} />
      <Route path="/bills/:shareCode/review" element={<ReviewBillPage />} />
      <Route path="/bills/:shareCode/share" element={<ShareBillPage />} />
      <Route path="/b/:shareCode" element={<BillPage />} />
    </Routes>
  )
}

export default App
