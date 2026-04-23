import { Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from './layouts/DashboardLayout';
import { DashboardPage } from './pages/DashboardPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/bookings" element={<PlaceholderPage title="Bookings" />} />
        <Route path="/crm" element={<PlaceholderPage title="CRM" />} />
        <Route path="/rota" element={<PlaceholderPage title="Rota" />} />
        <Route path="/sheer-lab" element={<PlaceholderPage title="Sheer Lab" />} />
        <Route path="/commission" element={<PlaceholderPage title="Commission" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
