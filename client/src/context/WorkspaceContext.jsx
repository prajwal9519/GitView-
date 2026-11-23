import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { repoService } from '../services/repoService';
import { mockRepositories } from '../data/mockRepositories';

const WorkspaceContext = createContext(null);

export const WorkspaceProvider = ({ children }) => {
  const [currentRepo, setCurrentRepo] = useState(null);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileMeta, setFileMeta] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);

  // README state
  const [readmeContent, setReadmeContent] = useState('');
  const [readmeMeta, setReadmeMeta] = useState(null);
  const [loadingReadme, setLoadingReadme] = useState(false);
  const [readmeError, setReadmeError] = useState(null);

  // Directory Tree state
  const [treeCache, setTreeCache] = useState({}); // { [dirPath]: entries[] }
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState(new Set(['']));

  const [mainViewMode, setMainViewMode] = useState('code'); // 'code' | 'readme' | 'deps'
  const [previewState, setPreviewState] = useState('idle'); // 'idle' | 'starting' | 'running' | 'stopping' | 'failed' | 'expired'
  const [previewPort, setPreviewPort] = useState(null);
  const [previewDevice, setPreviewDevice] = useState('desktop'); // 'desktop' | 'mobile'
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState([
    '> GitView Repository Explorer Online',
    '> Ready to inspect abstract syntax trees and file contents'
  ]);

  // Sync branch when currentRepo updates
  useEffect(() => {
    if (currentRepo?.defaultBranch && currentRepo.defaultBranch !== currentBranch) {
      setCurrentBranch(currentRepo.defaultBranch);
    }
  }, [currentRepo]);

  // Load directory tree for a specific folder path
  const fetchDirectory = useCallback(async (dirPath = '', forceRefresh = false, branchOverride = null) => {
    if (!currentRepo?.id) return;
    if (!forceRefresh && treeCache[dirPath]) return;

    const targetBranch = branchOverride || currentBranch || currentRepo.defaultBranch || 'main';

    setLoadingTree(true);
    setTreeError(null);
    try {
      const data = await repoService.getDirectoryTree(currentRepo.id, dirPath, targetBranch);
      setTreeCache((prev) => ({
        ...prev,
        [dirPath]: data.entries || [],
      }));
    } catch (err) {
      setTreeError(err.message || 'Failed to load directory tree');
    } finally {
      setLoadingTree(false);
    }
  }, [currentRepo, currentBranch, treeCache]);

  // Load root directory when repo changes
  useEffect(() => {
    if (currentRepo?.id) {
      setTreeCache({});
      setExpandedFolders(new Set(['']));
      const initialBranch = currentRepo.defaultBranch || 'main';
      setCurrentBranch(initialBranch);
      fetchDirectory('', true, initialBranch);
    }
  }, [currentRepo?.id]);

  // Load README.md
  const loadReadme = useCallback(async () => {
    if (!currentRepo?.id) return;
    const targetBranch = currentBranch || currentRepo.defaultBranch || 'main';
    setLoadingReadme(true);
    setReadmeError(null);
    try {
      const data = await repoService.getFileContent(currentRepo.id, 'README.md', targetBranch);
      if (typeof data === 'string') {
        setReadmeContent(data);
      } else {
        setReadmeContent(data.content || '');
        setReadmeMeta(data);
      }
    } catch {
      // Try lowercase readme.md
      try {
        const dataLower = await repoService.getFileContent(currentRepo.id, 'readme.md', targetBranch);
        setReadmeContent(dataLower.content || dataLower);
        setReadmeMeta(typeof dataLower === 'object' ? dataLower : null);
      } catch (err) {
        setReadmeError(err.message || 'No README.md file found in this repository.');
        setReadmeContent('');
      }
    } finally {
      setLoadingReadme(false);
    }
  }, [currentRepo?.id, currentRepo?.defaultBranch, currentBranch]);

  // Load a file's content
  const loadFile = useCallback(async (filePath) => {
    if (!filePath || !currentRepo?.id) return;
    const fileName = filePath.split('/').pop();
    const targetBranch = currentBranch || currentRepo.defaultBranch || 'main';

    setLoadingFile(true);
    setFileError(null);
    setActiveTab(filePath);

    if (!openTabs.includes(filePath)) {
      setOpenTabs((prev) => [...prev, filePath]);
    }

    if (filePath.toLowerCase().endsWith('readme.md')) {
      setMainViewMode('readme');
      loadReadme();
    } else {
      setMainViewMode('code');
    }

    try {
      const data = await repoService.getFileContent(currentRepo.id, filePath, targetBranch);
      if (typeof data === 'string') {
        setFileContent(data);
        setFileMeta({
          path: filePath,
          name: fileName,
          language: fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? 'typescript' : 'javascript',
          isBinary: false,
          tooLarge: false,
        });
      } else {
        setFileContent(data.content || '');
        setFileMeta(data);
      }
    } catch (err) {
      setFileError(err.message || 'Failed to load file content');
      setFileContent('');
      setFileMeta({
        path: filePath,
        name: fileName,
        language: 'plaintext',
      });
    } finally {
      setLoadingFile(false);
    }
  }, [currentRepo?.id, currentBranch, openTabs, loadReadme]);

  const selectFile = (filePath) => {
    loadFile(filePath);
  };

  const closeTab = (tabPath, e) => {
    if (e) e.stopPropagation();
    const filtered = openTabs.filter((t) => t !== tabPath);
    setOpenTabs(filtered);
    if (activeTab === tabPath) {
      if (filtered.length > 0) {
        loadFile(filtered[filtered.length - 1]);
      } else {
        setActiveTab('');
        setFileContent('');
        setFileMeta(null);
      }
    }
  };

  const toggleFolder = async (folderPath) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
        if (!treeCache[folderPath]) {
          fetchDirectory(folderPath);
        }
      }
      return next;
    });
  };

  const switchBranch = (newBranch) => {
    setCurrentBranch(newBranch);
    setTreeCache({});
    fetchDirectory('', true, newBranch);
  };

  const triggerSandboxRefresh = () => {
    setPreviewState('loading');
    setTimeout(() => {
      setPreviewState('running');
    }, 600);
  };

  const cyclePreviewState = () => {
    if (previewState === 'running') setPreviewState('loading');
    else if (previewState === 'loading') setPreviewState('failed');
    else setPreviewState('running');
  };

  const updatePreviewState = useCallback((val) => {
    setPreviewState((prev) => (prev === val ? prev : val));
  }, []);

  const updatePreviewPort = useCallback((val) => {
    setPreviewPort((prev) => (prev === val ? prev : val));
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        currentRepo,
        setCurrentRepo,
        currentBranch,
        switchBranch,
        treeCache,
        expandedFolders,
        loadingTree,
        treeError,
        fetchDirectory,
        toggleFolder,
        openTabs,
        activeTab,
        selectFile,
        closeTab,
        fileContent,
        fileMeta,
        fileError,
        loadingFile,
        loadFile,
        readmeContent,
        readmeMeta,
        loadingReadme,
        readmeError,
        loadReadme,
        mainViewMode,
        setMainViewMode,
        previewState,
        setPreviewState: updatePreviewState,
        previewPort,
        setPreviewPort: updatePreviewPort,
        previewDevice,
        setPreviewDevice,
        isPreviewOpen,
        setIsPreviewOpen,
        terminalLogs,
        triggerSandboxRefresh,
        cyclePreviewState,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
};

export const useWorkspace = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
};
