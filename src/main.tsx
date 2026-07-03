// React entry point — mounts the App component into the #root DOM element.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// Locate the root DOM node and create a React 18 root
const root = ReactDOM.createRoot(document.getElementById('root')!);

// Render the App wrapped in StrictMode for development warnings
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
