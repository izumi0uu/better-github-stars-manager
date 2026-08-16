import { createRoot } from 'react-dom/client';
import { DemoManagerApp } from '@/demo/DemoManagerApp';
import '@/ui/styles/index.css';
import '@/demo/demo-shell.css';

const root = document.getElementById('root');
if (!root) throw new Error('Demo root element is missing.');

createRoot(root).render(<DemoManagerApp />);
