// In sidebar-recent.tsx (of vergelijkbaar bestand)
import { useEffect, useState } from 'react';
import axios from 'axios';

export function SidebarRecent() {
  const [recentItems, setRecentItems] = useState([]);

  useEffect(() => {
    // Haal recente items op (normaal gesproken)
    axios.get('/api/files/recent').then(res => setRecentItems(res.data));

    // Haal ook SMB-shares op (tijdelijk voor testen)
    axios.get('/api/files/smb/shares').then(res => {
      setRecentItems(prev => [...prev, ...res.data]);
    });
  }, []);

  return (
    <div>
      <h4>Recente items</h4>
      {recentItems.map(item => (
        <div key={item.path} className="sidebar-item">
          <span>{item.name}</span>
        </div>
      ))}
    </div>
  );
}
