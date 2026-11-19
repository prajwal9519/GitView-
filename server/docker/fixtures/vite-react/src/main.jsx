import React from 'react';
import ReactDOM from 'react-dom/client';

export function App() {
  return React.createElement('h1', null, 'GitView React Preview');
}

const rootElement = document.getElementById('root');
if (!window.__gitview_root) {
  window.__gitview_root = ReactDOM.createRoot(rootElement);
}
window.__gitview_root.render(React.createElement(App));

if (import.meta.hot) {
  import.meta.hot.accept();
}


