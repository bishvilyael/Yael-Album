(() => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const ROOT = window.YAEL_CONFIG.ROOT_FOLDER_ID;
  const CLIENT_ID = window.YAEL_CONFIG.GOOGLE_CLIENT_ID;
  const stateKey = 'yael.pwa.state.v1';
  const authKey = 'yael.pwa.authorized.v1';
  let tokenClient = null;
  let accessToken = null;
  let currentFolder = null;
  let currentFiles = [];
  let currentIndex = -1;
  let frontFile = null;
  let backFile = null;
  let textFile = null;
  let objectUrl = null;
  let scale = 1, x = 0, y = 0;
  let drag = null;
  let frontLoadSerial = 0;

  const $ = id => document.getElementById(id);
  const tree = $('tree'), drawer = $('drawer'), photo = $('photo'), textView = $('textView');
  const status = $('status'), emptyState = $('emptyState');

  const setStatus = msg => status.textContent = msg;
  const saveState = () => {
    try { localStorage.setItem(stateKey, JSON.stringify({folderId: currentFolder?.id || null, fileId: frontFile?.id || null})); } catch {}
  };
  const loadState = () => { try { return JSON.parse(localStorage.getItem(stateKey) || '{}'); } catch { return {}; } };
  const wasAuthorized = () => { try { return localStorage.getItem(authKey) === '1'; } catch { return false; } };
  const rememberAuthorized = () => { try { localStorage.setItem(authKey, '1'); } catch {} };

  function waitForGoogle() {
    if (window.google?.accounts?.oauth2) return initAuth();
    setTimeout(waitForGoogle, 100);
  }

  function initAuth() {
    if (!CLIENT_ID || CLIENT_ID.startsWith('PASTE_')) {
      setStatus('נדרש להגדיר Google OAuth Client ID בקובץ config.js');
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: async resp => {
        if (resp.error) {
          $('loginBtn').disabled = false;
          $('loginBtn').textContent = 'התחברות ל‑Google';
          return setStatus('ההתחברות נכשלה: ' + resp.error);
        }
        accessToken = resp.access_token;
        rememberAuthorized();
        $('loginBtn').textContent = 'מחובר';
        $('loginBtn').disabled = true;
        setStatus('מחובר ל‑Google Drive');
        await buildRoot();
      },
      error_callback: err => {
        // Browsers (especially iPhone/Safari) can block an automatic OAuth popup.
        // In that case we simply leave the normal login button available.
        console.debug('Yael OAuth popup:', err);
        $('loginBtn').disabled = false;
        $('loginBtn').textContent = 'התחברות ל‑Google';
        if (err?.type !== 'popup_failed_to_open') setStatus('לחץ התחברות ל‑Google');
      }
    });


  }

  $('loginBtn').onclick = () => {
    if (!tokenClient) return setStatus('Google עדיין נטען…');
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'מתחבר…';
    // Important: do NOT force prompt:'consent'. Google reuses the prior grant when possible.
    tokenClient.requestAccessToken();
  };
  $('treeBtn').onclick = () => drawer.classList.add('open');
  $('closeDrawer').onclick = () => drawer.classList.remove('open');

  async function drive(url, options={}) {
    const res = await fetch(url, { ...options, headers: { ...(options.headers||{}), Authorization: `Bearer ${accessToken}` }});
    if (res.status === 401) {
      accessToken = null;
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = 'התחברות ל‑Google';
      throw new Error('פג תוקף ההתחברות. התחבר מחדש.');
    }
    if (!res.ok) throw new Error(`Google Drive: ${res.status}`);
    return res;
  }

  async function getMeta(id) {
    const f = 'id,name,mimeType,parents,capabilities(canDownload,canEdit),modifiedTime';
    return (await drive(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(f)}&supportsAllDrives=true`)).json();
  }

  async function listChildren(folderId) {
    const q = `'${folderId}' in parents and trashed=false`;
    const fields = 'nextPageToken,files(id,name,mimeType,modifiedTime,size,capabilities(canDownload,canEdit))';
    let pageToken = '', out = [];
    do {
      const u = new URL('https://www.googleapis.com/drive/v3/files');
      u.searchParams.set('q', q); u.searchParams.set('fields', fields); u.searchParams.set('pageSize','1000');
      u.searchParams.set('orderBy','folder,name_natural'); u.searchParams.set('supportsAllDrives','true'); u.searchParams.set('includeItemsFromAllDrives','true');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const data = await (await drive(u)).json(); out.push(...(data.files||[])); pageToken = data.nextPageToken || '';
    } while(pageToken);
    return out;
  }

  async function buildRoot() {
    try {
      const rootMeta = await getMeta(ROOT);
      tree.innerHTML = '';
      const rootNode = makeFolderRow(rootMeta, 0, true);
      tree.appendChild(rootNode.row);
      await expandFolder(rootMeta, rootNode.children, rootNode.chev, 0);
      const saved = loadState();
      if (saved.folderId && saved.folderId !== ROOT) await restoreFolder(saved.folderId, saved.fileId);
      else await openFolder(rootMeta, saved.fileId);
    } catch(e) { setStatus(e.message); tree.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`; }
  }

  function makeFolderRow(folder, depth, isRoot=false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div'); row.className='tree-row'; row.style.paddingRight = `${depth*14}px`;
    const chev = document.createElement('span'); chev.className='chev'; chev.textContent='›';
    const btn = document.createElement('button'); btn.textContent = isRoot ? '📁 האלבום' : `📁 ${folder.name}`;
    row.append(chev, btn); wrap.appendChild(row);
    const children = document.createElement('div'); wrap.appendChild(children);
    let expanded=false, loaded=false;
    async function toggle(){
      expanded=!expanded; chev.textContent=expanded?'⌄':'›'; children.hidden=!expanded;
      if(expanded && !loaded){ loaded=true; await expandFolder(folder, children, chev, depth); }
    }
    chev.onclick=toggle; btn.onclick=async()=>{ await openFolder(folder); if(innerWidth<900) drawer.classList.remove('open'); };
    if(isRoot){ expanded=true; children.hidden=false; chev.textContent='⌄'; loaded=true; }
    return {row:wrap, children, chev};
  }

  async function expandFolder(folder, host, chev, depth) {
    try {
      const items = await listChildren(folder.id);
      for (const f of items.filter(x=>x.mimeType===FOLDER_MIME)) host.appendChild(makeFolderRow(f, depth+1).row);
      if (!host.children.length) chev.textContent='';
    } catch(e){ setStatus(e.message); }
  }

  async function openFolder(folder, preferredFileId=null) {
    currentFolder=folder; setStatus(`פותח: ${folder.name}`);
    const items=await listChildren(folder.id);
    currentFiles = items.filter(f => /^image\//.test(f.mimeType) && !/^back$/i.test(f.name));
    currentIndex = preferredFileId ? currentFiles.findIndex(f=>f.id===preferredFileId) : 0;
    if(currentIndex<0) currentIndex=0;
    if(currentFiles.length) await showFront(currentIndex); else clearViewer('אין תמונות בתיקייה זו');
    saveState();
  }

  async function restoreFolder(folderId, fileId) {
    try { const meta=await getMeta(folderId); await openFolder(meta,fileId); } catch { /* fallback already root */ }
  }

  function clearViewer(msg) {
    frontLoadSerial++;
    revokeObject(); photo.hidden=true; textView.hidden=true; emptyState.hidden=false; emptyState.textContent=msg;
    frontFile=backFile=textFile=null; currentIndex=-1; updateControls(); updateTabs();
  }

  async function fetchBlob(file) {
    return (await drive(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`)).blob();
  }
  function revokeObject(){ if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl=null; } }
  async function renderImage(file) {
    setStatus(`טוען ${file.name}…`);
    const blob = await fetchBlob(file);
    revokeObject();
    objectUrl = URL.createObjectURL(blob);

    photo.hidden = false;
    textView.hidden = true;
    emptyState.hidden = true;

    await new Promise((resolve, reject) => {
      photo.onload = () => resolve();
      photo.onerror = () => reject(new Error('לא ניתן להציג את התמונה'));
      photo.src = objectUrl;
    });

    fitImage();
    setStatus(file.name);
  }

  async function findCompanions(file) {
    backFile=textFile=null;
    updateTabs();
    const items = await listChildren(currentFolder.id);
    const backFolder = items.find(f=>f.mimeType===FOLDER_MIME && f.name.toLowerCase()==='back');
    if(!backFolder) return updateTabs();
    const bitems=await listChildren(backFolder.id);
    const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
    backFile = bitems.find(f =>
      /^image\//.test(f.mimeType) &&
      f.name.replace(/\.[^.]+$/, '').toLowerCase() === stem
    ) || null;
    textFile = bitems.find(f =>
      f.name.replace(/\.[^.]+$/, '').toLowerCase() === stem &&
      (f.mimeType === 'text/plain' || f.name.toLowerCase().endsWith('.txt'))
    ) || null;
    updateTabs();
  }

  async function showFront(i) {
    if(!currentFiles.length) return;
    const serial = ++frontLoadSerial;
    currentIndex=(i+currentFiles.length)%currentFiles.length;
    frontFile=currentFiles[currentIndex];

    // Hide the previous image immediately. The new front is shown only after
    // Drive has finished determining whether Back/TXT exist and the buttons are updated.
    revokeObject();
    photo.hidden=true;
    textView.hidden=true;
    emptyState.hidden=false;
    emptyState.textContent='טוען…';
    backFile=null;
    textFile=null;
    updateTabs();
    setActiveTab('front');
    setStatus(`בודק גב וטקסט עבור ${frontFile.name}…`);

    await findCompanions(frontFile);
    if (serial !== frontLoadSerial) return;

    // At this point Back/TXT buttons already reflect the selected image.
    await renderImage(frontFile);
    if (serial !== frontLoadSerial) return;

    setActiveTab('front');
    saveState();
    updateControls();
  }
  async function showBack(){ if(backFile){ await renderImage(backFile); setActiveTab('back'); } }
  async function showText(){
    if(!textFile) return; setStatus(`טוען ${textFile.name}…`);
    const blob=await fetchBlob(textFile); const txt=await blob.text(); revokeObject(); photo.hidden=true; emptyState.hidden=true; textView.hidden=false; textView.textContent=txt; setActiveTab('text'); setStatus(textFile.name);
  }

  function updateTabs(){ $('backTab').disabled=!backFile; $('textTab').disabled=!textFile; }
  function setActiveTab(which){ ['front','back','text'].forEach(n=>$(n+'Tab').classList.toggle('active',n===which)); }
  function updateControls(){ const ok=currentFiles.length>0; ['prevBtn','nextBtn','zoomOutBtn','zoomInBtn','resetBtn'].forEach(id=>$(id).disabled=!ok); }
  $('frontTab').onclick=()=>frontFile&&renderImage(frontFile).then(()=>setActiveTab('front'));
  $('backTab').onclick=showBack; $('textTab').onclick=showText;
  $('prevBtn').onclick=()=>showFront(currentIndex-1); $('nextBtn').onclick=()=>showFront(currentIndex+1);

  function applyTransform(){ photo.style.transform=`translate(${x}px,${y}px) scale(${scale})`; }
  function fitImage() {
    if (!photo.naturalWidth || !photo.naturalHeight) return;
    const stage = $('imageStage');
    const availableWidth = stage.clientWidth;
    const availableHeight = stage.clientHeight;
    scale = Math.min(availableWidth / photo.naturalWidth, availableHeight / photo.naturalHeight);
    x = 0;
    y = 0;
    applyTransform();
  }
  function resetTransform(){ fitImage(); }
  $('zoomInBtn').onclick=()=>{ scale=Math.min(8,scale*1.25); applyTransform(); };
  $('zoomOutBtn').onclick=()=>{ scale=Math.max(.25,scale/1.25); applyTransform(); };
  $('resetBtn').onclick=resetTransform;
  $('imageStage').addEventListener('wheel',e=>{ if(photo.hidden)return; e.preventDefault(); scale=Math.max(.25,Math.min(8,scale*(e.deltaY<0?1.12:.89))); applyTransform(); },{passive:false});
  $('imageStage').addEventListener('pointerdown',e=>{ if(photo.hidden)return; drag={id:e.pointerId,sx:e.clientX,sy:e.clientY,ox:x,oy:y}; $('imageStage').setPointerCapture(e.pointerId); });
  $('imageStage').addEventListener('pointermove',e=>{ if(!drag||drag.id!==e.pointerId)return; x=drag.ox+(e.clientX-drag.sx); y=drag.oy+(e.clientY-drag.sy); applyTransform(); });
  $('imageStage').addEventListener('pointerup',()=>drag=null); $('imageStage').addEventListener('pointercancel',()=>drag=null);

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
  waitForGoogle();
})();
