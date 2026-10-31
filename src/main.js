import './style.css';
import { auth, db } from './firebase.js';

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth';

import {
  collection, doc, setDoc, getDoc, getDocs, addDoc,
  updateDoc, deleteDoc, query, where, limit, orderBy,
  onSnapshot, serverTimestamp
} from 'firebase/firestore';

const root = document.querySelector('#app');

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;',
  '"': '&quot;', "'": '&#39;'
}[c]));

const initial = (n = '?') =>
  esc(n.trim().charAt(0).toUpperCase() || '?');

const fmtTime = ts => ts?.toDate
  ? ts.toDate().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit'
    })
  : '';

async function enableNotifications() {
  if (!('Notification' in window)) {
    return alert('This browser does not support notifications.');
  }

  const permission = await Notification.requestPermission();

  alert(permission === 'granted'
    ? 'Notifications enabled in this browser.'
    : 'Notification permission was not granted.');
}

function notifyMessage(title, body) {
  if (
    'Notification' in window &&
    Notification.permission === 'granted' &&
    document.visibilityState !== 'visible'
  ) {
    try {
      new Notification(title, { body });
    } catch {}
  }
}

function showMedia(url, type = 'image') {
  const old = document.querySelector('#mediaViewer');
  if (old) old.remove();

  const viewer = document.createElement('div');
  viewer.id = 'mediaViewer';
  viewer.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;padding:18px;';

  const media = type === 'video'
    ? document.createElement('video')
    : document.createElement('img');

  media.src = url;
  media.style.cssText =
    'max-width:100%;max-height:88vh;object-fit:contain;border-radius:10px;';

  if (type === 'video') {
    media.controls = true;
    media.autoplay = true;
  }

  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText =
    'position:absolute;right:18px;top:18px;font-size:22px;background:#222;color:white;border:0;border-radius:50%;width:42px;height:42px;';

  close.onclick = () => viewer.remove();

  viewer.onclick = e => {
    if (e.target === viewer) viewer.remove();
  };

  viewer.append(media, close);
  document.body.append(viewer);
}

let me = null;
let users = {};
let watchers = {};
let chats = [];
let tab = 'chats';
let currentChat = null;
let inProfile = false;
let unsubs = [];
let msgUnsub = null;
let recorder = null;
let recChunks = [];
let signingUp = false;
let searchText = '';
let searchResults = [];
let searchMsg = '';
let picked = new Set();

// Theme
document.documentElement.dataset.theme =
  localStorage.getItem('dan-theme') || 'dark';

function toggleTheme() {
  const next =
    document.documentElement.dataset.theme === 'dark'
      ? 'light'
      : 'dark';

  document.documentElement.dataset.theme = next;
  localStorage.setItem('dan-theme', next);
}

// Avatar / DP
function avatar(u, cls = '') {
  const online = u?.online ? ' online' : '';

  if (u?.photo) {
    return `<div class="avatar ${cls}${online}">
      <img src="${esc(u.photo)}" alt="" />
    </div>`;
  }

  return `<div class="avatar ${cls}${online}">
    ${initial(u?.name || '?')}
  </div>`;
}

// Login and signup
function renderAuth(mode = 'login', error = '') {
  root.innerHTML = `
    <div class="auth">
      <div class="logo">💬</div>
      <h1><span class="g">DAN</span> Chat</h1>
      <p class="sub">WhatsApp-style chat app</p>

      ${mode === 'signup' ? `
        <input id="name" placeholder="Your name" />
        <input id="uname" placeholder="Username (e.g. imran_01)"
          autocapitalize="none" />
      ` : ''}

      <input id="email" type="email" placeholder="Email" />
      <input id="pass" type="password"
        placeholder="Password (min 6 chars)" />

      <div class="err">${esc(error)}</div>

      <button id="go" class="primary">
        ${mode === 'signup' ? 'Create account' : 'Login'}
      </button>

      <button id="switch" class="link">
        ${mode === 'signup'
          ? 'Already have an account? Login'
          : 'New here? Sign up'}
      </button>
    </div>`;

  root.querySelector('#switch').onclick = () =>
    renderAuth(mode === 'signup' ? 'login' : 'signup');

  root.querySelector('#go').onclick = async () => {
    const email = root.querySelector('#email')
      .value.trim().toLowerCase();

    const pass = root.querySelector('#pass').value;

    try {
      if (mode === 'signup') {
        const name =
          root.querySelector('#name').value.trim() ||
          email.split('@')[0];

        const username = root.querySelector('#uname')
          .value.trim().toLowerCase().replace(/^@/, '');

        if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
          throw new Error(
            'Username: 3-20 letters, numbers, _ or . only'
          );
        }

        signingUp = true;

        const cred = await createUserWithEmailAndPassword(
          auth, email, pass
        );

        try {
          await setDoc(doc(db, 'usernames', username), {
            uid: cred.user.uid
          });
        } catch {
          await cred.user.delete();
          throw new Error(
            'This username is already taken. Try another one.'
          );
        }

        await updateProfile(cred.user, { displayName: name });

        await setDoc(doc(db, 'users', cred.user.uid), {
          name,
          username,
          email,
          online: true,
          lastSeen: serverTimestamp()
        });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (e) {
      renderAuth(mode, e.message.replace('Firebase: ', ''));
    } finally {
      signingUp = false;
    }
  };
}

onAuthStateChanged(auth, async user => {
  cleanup();
  me = user;

  if (!user) return renderAuth();

  if (!signingUp) {
    const uref = doc(db, 'users', user.uid);
    const snap = await getDoc(uref);

    if (snap.exists()) {
      await updateDoc(uref, {
        online: true,
        lastSeen: serverTimestamp()
      });
    } else {
      await setDoc(uref, {
        name: user.displayName || user.email.split('@')[0],
        email: (user.email || '').toLowerCase(),
        online: true,
        lastSeen: serverTimestamp()
      });
    }
  }

  watchUser(user.uid);
  watchIncomingCalls();

  unsubs.push(onSnapshot(
    query(
      collection(db, 'chats'),
      where('members', 'array-contains', user.uid)
    ),
    snap => {
      chats = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) =>
          (b.updatedAt?.seconds || 0) -
          (a.updatedAt?.seconds || 0)
        );

      chats.forEach(c => c.members.forEach(watchUser));
      rerender();
    }
  ));

  renderHome();
});

function watchUser(uid) {
  if (watchers[uid]) return;

  watchers[uid] = onSnapshot(doc(db, 'users', uid), snap => {
    if (snap.exists()) users[uid] = snap.data();
    rerender();
  }, () => {});
}

function rerender() {
  if (me && !currentChat && !inProfile) renderHome();
}

function setPresence(online) {
  if (!me) return;

  updateDoc(doc(db, 'users', me.uid), {
    online,
    lastSeen: serverTimestamp()
  }).catch(() => {});
}

document.addEventListener('visibilitychange', () =>
  setPresence(document.visibilityState === 'visible')
);

window.addEventListener('beforeunload', () =>
  setPresence(false)
);

function cleanup() {
  unsubs.forEach(u => u());
  Object.values(watchers).forEach(u => u());

  unsubs = [];
  watchers = {};

  if (msgUnsub) msgUnsub();

  cleanupCall();

  msgUnsub = null;
  currentChat = null;
  inProfile = false;
  users = {};
  chats = [];
  searchResults = [];
  searchMsg = '';
  searchText = '';
  picked = new Set();
}

const otherId = c => c.members.find(m => m !== me.uid);

const chatTitle = c => c.isGroup
  ? (c.name || 'Group')
  : (users[otherId(c)]?.name || 'User');

const dmId = (a, b) => [a, b].sort().join('_');

function renderHome() {
  if (!me) return;

  currentChat = null;
  inProfile = false;

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <h2><span class="g">DAN</span> Chat</h2>
        <div class="actions">
          <button class="icon" id="themeBtn" title="Change theme">🌙</button>
          <button class="icon" id="notifyBtn" title="Notifications">🔔</button>
          <button class="icon" id="profileBtn" title="My profile">👤</button>
          <button class="icon" id="logoutBtn" title="Logout">↪</button>
        </div>
      </header>

      <div class="searchbox">
        <input id="friendSearch"
          placeholder="Search username or full email..."
          value="${esc(searchText)}" />
        <button id="searchBtn" class="primary">Search</button>
      </div>

      <div id="searchResults" class="search-results">
        ${renderSearchResults()}
      </div>

      <nav class="tabs">
        <button data-tab="chats" class="${tab === 'chats' ? 'active' : ''}">
          Chats
        </button>
        <button data-tab="groups" class="${tab === 'groups' ? 'active' : ''}">
          Groups
        </button>
        <button data-tab="newgroup" class="${tab === 'newgroup' ? 'active' : ''}">
          + Group
        </button>
      </nav>

      <main id="chatList" class="chat-list">
        ${renderChatList()}
      </main>
    </div>`;

  root.querySelector('#themeBtn').onclick = toggleTheme;
  root.querySelector('#notifyBtn').onclick = enableNotifications;
  root.querySelector('#profileBtn').onclick = () => showProfile(me.uid);
  root.querySelector('#logoutBtn').onclick = async () => {
    setPresence(false);
    await signOut(auth);
  };

  const input = root.querySelector('#friendSearch');

  input.addEventListener('input', e => {
    searchText = e.target.value;
  });

  root.querySelector('#searchBtn').onclick = searchFriends;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchFriends();
  });

  root.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      tab = btn.dataset.tab;

      if (tab === 'newgroup') {
        showCreateGroup();
      } else {
        renderHome();
      }
    };
  });

  root.querySelectorAll('[data-user]').forEach(btn => {
    btn.onclick = () => startDM(btn.dataset.user);
  });

  root.querySelectorAll('[data-open-chat]').forEach(btn => {
    btn.onclick = () => openChat(btn.dataset.openChat);
  });

  root.querySelectorAll('[data-profile]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      showProfile(btn.dataset.profile);
    };
  });
}

function renderSearchResults() {
  if (searchMsg) {
    return `<p class="sub">${esc(searchMsg)}</p>`;
  }

  if (!searchResults.length) return '';

  return searchResults.map(u => `
    <div class="chat-row">
      <button class="avatar-btn" data-profile="${esc(u.uid)}">
        ${avatar(u)}
      </button>

      <div class="chat-info">
        <strong>${esc(u.name || 'User')}</strong>
        <small>@${esc(u.username || '')} · ${esc(u.email || '')}</small>
      </div>

      <button class="primary" data-user="${esc(u.uid)}">
        Chat
      </button>
    </div>
  `).join('');
}

async function searchFriends() {
  const value = searchText.trim().toLowerCase();

  searchMsg = '';
  searchResults = [];

  if (!value) {
    searchMsg = 'Enter a username or full email address.';
    renderHome();
    return;
  }

  if (value.includes('@') && !value.includes('.')) {
    searchMsg = 'Enter the full email address.';
    renderHome();
    return;
  }

  searchMsg = 'Searching...';
  renderHome();

  try {
    let results = [];

    if (value.includes('@')) {
      const q = query(
        collection(db, 'users'),
        where('email', '==', value),
        limit(10)
      );

      const snap = await getDocs(q);

      results = snap.docs.map(d => ({
        uid: d.id,
        ...d.data()
      }));
    } else {
      const username = value.replace(/^@/, '');

      const snap = await getDoc(
        doc(db, 'usernames', username)
      );

      if (snap.exists()) {
        const uid = snap.data().uid;

        if (uid && uid !== me.uid) {
          const userSnap = await getDoc(doc(db, 'users', uid));

          if (userSnap.exists()) {
            results.push({
              uid,
              ...userSnap.data()
            });
          }
        }
      }
    }

    searchResults = results.filter(u => u.uid !== me.uid);

    searchResults.forEach(u => { users[u.uid] = u; });

    searchMsg = searchResults.length
      ? ''
      : 'No matching user found.';

    renderHome();
  } catch (error) {
    console.error(error);
    searchMsg = 'Search failed. Check Firestore rules and try again.';
    renderHome();
  }
}

function renderChatList() {
  const filtered = chats.filter(c =>
    tab === 'groups' ? c.isGroup : !c.isGroup
  );

  if (!filtered.length) {
    return `<div class="empty">
      <div style="font-size:38px">💬</div>
      <p>No ${tab === 'groups' ? 'groups' : 'chats'} yet.</p>
      <small>Search for a friend above to start chatting.</small>
    </div>`;
  }

  return filtered.map(c => {
    const uid = c.isGroup ? null : otherId(c);
    const person = uid ? users[uid] : null;

    return `
      <button class="chat-row" data-open-chat="${esc(c.id)}">
        ${
          c.isGroup
            ? `<div class="avatar">👥</div>`
            : avatar(person)
        }

        <div class="chat-info">
          <strong>${esc(chatTitle(c))}</strong>
          <small>${esc(c.lastMessage || 'Start a conversation')}</small>
        </div>

        <small class="time">${fmtTime(c.updatedAt)}</small>
      </button>`;
  }).join('');
}

async function startDM(uid) {
  if (!uid || uid === me.uid) return;

  try {
    const id = dmId(me.uid, uid);
    const ref = doc(db, 'chats', id);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, {
        members: [me.uid, uid],
        isGroup: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessage: ''
      });
    }

    const fresh = await getDoc(ref);

    if (fresh.exists()) {
      watchUser(uid);
      openChat(id);
    }
  } catch (error) {
    console.error(error);
    alert('Could not open chat. Check Firestore permissions.');
  }
}

async function showCreateGroup() {
  try {
    const contacts = Object.entries(users)
      .filter(([uid]) => uid !== me.uid)
      .map(([uid, u]) => ({ uid, ...u }));

    root.innerHTML = `
      <div class="profile">
        <button id="back" class="icon">← Back</button>
        <h2>Create group</h2>
        <input id="groupName" placeholder="Group name" />

        <h3>Select members</h3>

        <div class="contact-list">
          ${contacts.map(u => `
            <label class="chat-row">
              <input type="checkbox" value="${esc(u.uid)}" />
              ${avatar(u)}
              <span>${esc(u.name || u.email || 'User')}</span>
            </label>
          `).join('')}
        </div>

        <button id="createGroup" class="primary">
          Create group
        </button>
      </div>`;

    root.querySelector('#back').onclick = () => {
      tab = 'chats';
      renderHome();
    };

    root.querySelector('#createGroup').onclick = async () => {
      const name = root.querySelector('#groupName').value.trim();

      const members = [
        me.uid,
        ...Array.from(
          root.querySelectorAll('input[type="checkbox"]:checked')
        ).map(el => el.value)
      ];

      if (!name) return alert('Enter a group name.');
      if (members.length < 2) {
        return alert('Select at least one other member.');
      }

      try {
        const ref = await addDoc(collection(db, 'chats'), {
          name,
          members: [...new Set(members)],
          isGroup: true,
          createdBy: me.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          lastMessage: ''
        });

        tab = 'chats';
        openChat(ref.id);
      } catch (error) {
        console.error(error);
        alert('Group creation failed. Check Firestore rules.');
      }
    };
  } catch (error) {
    console.error(error);
    alert('Could not load contacts.');
  }
}

async function openChat(chatId) {
  if (msgUnsub) msgUnsub();

  const snap = await getDoc(doc(db, 'chats', chatId));

  if (!snap.exists()) {
    alert('Chat not found.');
    return renderHome();
  }

  currentChat = { id: chatId, ...snap.data() };
  inProfile = false;

  renderChat();

  const q = query(
    collection(db, 'chats', chatId, 'messages'),
    orderBy('createdAt', 'asc')
  );

  msgUnsub = onSnapshot(q, snapshot => {
    const messages = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    const area = root.querySelector('#msgs');
    if (!area) return;

    area.innerHTML = messages.map(msgHtml).join('');
    area.scrollTop = area.scrollHeight;

    area.querySelectorAll('[data-media]').forEach(el => {
      el.onclick = () =>
        showMedia(el.dataset.media, el.dataset.type || 'image');
    });

    area.querySelectorAll('[data-delete]').forEach(el => {
      el.onclick = () => deleteMessage(el.dataset.delete);
    });

    area.querySelectorAll('[data-audio]').forEach(el => {
      el.onclick = () => {
        const audio = new Audio(el.dataset.audio);
        audio.play().catch(() => alert('Could not play audio.'));
      };
    });
  }, error => {
    console.error(error);
    alert('Could not load messages. Check Firestore rules.');
  });
}

function renderChat() {
  const c = currentChat;
  if (!c) return;

  const uid = c.isGroup ? null : otherId(c);
  const person = uid ? users[uid] : null;

  root.innerHTML = `
    <div class="chat-screen">
      <header class="topbar">
        <button id="back" class="icon">←</button>

        <button id="openProfile" class="profile-head">
          ${c.isGroup
            ? '<div class="avatar">👥</div>'
            : avatar(person)}
          <span>
            <strong>${esc(chatTitle(c))}</strong>
            <small>${c.isGroup
              ? `${c.members.length} members`
              : person?.online ? 'Online' : 'Offline'}</small>
          </span>
        </button>

        <div class="actions">
          <button id="audioCall" class="icon" title="Audio call">📞</button>
          <button id="videoCall" class="icon" title="Video call">📹</button>
        </div>
      </header>

      <div id="msgs" class="msgs">
        <p class="sub">Loading messages...</p>
      </div>

      <form id="composer" class="composer">
        <button type="button" id="pickPhoto" class="icon">📷</button>
        <button type="button" id="pickVideo" class="icon">🎥</button>
        <button type="button" id="recordVoice" class="icon">🎙️</button>

        <input id="messageInput" placeholder="Type a message..." />

        <button type="submit" class="primary">➤</button>

        <input type="file" id="photoInput" accept="image/*" hidden />
        <input type="file" id="videoInput" accept="video/*" hidden />
      </form>
    </div>`;

  root.querySelector('#back').onclick = () => {
    if (msgUnsub) msgUnsub();
    msgUnsub = null;
    currentChat = null;
    renderHome();
  };

  root.querySelector('#openProfile').onclick = () => {
    if (c.isGroup) {
      showGroupMembers(c);
    } else {
      showProfile(uid);
    }
  };

  root.querySelector('#audioCall').onclick = () => {
    const uid = c.isGroup ? null : otherId(c);

    if (!uid) {
      alert('Calling is available for direct chats only.');
      return;
    }

    startCall(uid, 'audio');
  };

  root.querySelector('#videoCall').onclick = () => {
    const uid = c.isGroup ? null : otherId(c);

    if (!uid) {
      alert('Calling is available for direct chats only.');
      return;
    }

    startCall(uid, 'video');
  };

  root.querySelector('#composer').onsubmit = async e => {
    e.preventDefault();

    const input = root.querySelector('#messageInput');
    const text = input.value.trim();

    if (!text) return;

    input.value = '';

    try {
      await sendMessage({
        type: 'text',
        text
      });
    } catch (error) {
      console.error(error);
      alert('Message could not be sent.');
    }
  };

  root.querySelector('#pickPhoto').onclick = () =>
    root.querySelector('#photoInput').click();

  root.querySelector('#pickVideo').onclick = () =>
    root.querySelector('#videoInput').click();

  root.querySelector('#photoInput').onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (!file.type.startsWith('image/')) {
        throw new Error('Please choose an image.');
      }

      const url = await compressImage(file);

      await sendMessage({
        type: 'image',
        url,
        text: file.name
      });
    } catch (error) {
      alert(error.message || 'Image upload failed.');
    }

    e.target.value = '';
  };

  root.querySelector('#videoInput').onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    alert(
      'Direct Firestore video storage is not supported in this demo. ' +
      'Firebase Storage upload must be configured for video messages.'
    );

    e.target.value = '';
  };

  root.querySelector('#recordVoice').onclick = recordVoice;
}

async function sendMessage(data) {
  if (!me || !currentChat) return;

  const c = currentChat;

  await addDoc(
    collection(db, 'chats', c.id, 'messages'),
    {
      ...data,
      from: me.uid,
      createdAt: serverTimestamp()
    }
  );

  await updateDoc(doc(db, 'chats', c.id), {
    lastMessage: data.type === 'text'
      ? data.text
      : data.type === 'image'
        ? '📷 Photo'
        : data.type === 'video'
          ? '🎥 Video'
          : '🎙️ Voice message',
    updatedAt: serverTimestamp()
  });
}

function msgHtml(m) {
  const mine = m.from === me.uid;

  let content = '';

  if (m.type === 'image' && m.url) {
    content = `
      <img
        class="message-image"
        src="${esc(m.url)}"
        data-media="${esc(m.url)}"
        data-type="image"
        alt="Shared photo"
      />`;
  } else if (m.type === 'video' && m.url) {
    content = `
      <video
        class="message-video"
        src="${esc(m.url)}"
        controls
        preload="metadata"
        data-media="${esc(m.url)}"
        data-type="video"
      ></video>`;
  } else if (m.type === 'audio' && m.url) {
    content = `
      <button class="primary"
        data-audio="${esc(m.url)}">▶ Play voice message</button>`;
  } else {
    content = `<div class="message-text">${esc(m.text || '')}</div>`;
  }

  return `
    <div class="msg-row ${mine ? 'mine' : 'theirs'}">
      <div class="bubble">
        ${content}
        <small class="msg-time">${fmtTime(m.createdAt)}</small>
        ${mine ? `
          <button class="delete-msg"
            data-delete="${esc(m.id)}"
            title="Delete message">🗑️</button>` : ''}
      </div>
    </div>`;
}

async function deleteMessage(id) {
  if (!currentChat || !confirm('Delete this message?')) return;

  try {
    const ref = doc(
      db, 'chats', currentChat.id, 'messages', id
    );

    const snap = await getDoc(ref);

    if (!snap.exists()) return;

    if (snap.data().from !== me.uid) {
      return alert('You can delete only your own messages.');
    }

    await deleteDoc(ref);
  } catch (error) {
    console.error(error);
    alert('Could not delete message.');
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Could not read image.'));

    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new Error('Invalid image.'));

      img.onload = () => {
        const max = 800;
        const scale = Math.min(1, max / Math.max(img.width, img.height));

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const data = canvas.toDataURL('image/jpeg', 0.65);

        if (data.length > 850000) {
          reject(new Error(
            'Image is too large after compression. Choose a smaller image.'
          ));
        } else {
          resolve(data);
        }
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

async function recordVoice() {
  if (!navigator.mediaDevices?.getUserMedia ||
      !window.MediaRecorder) {
    return alert('Voice recording is not supported in this browser.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    recorder = new MediaRecorder(stream);
    recChunks = [];

    recorder.ondataavailable = e => {
      if (e.data.size) recChunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());

      try {
        const blob = new Blob(recChunks, {
          type: recorder.mimeType || 'audio/webm'
        });

        if (blob.size > 500000) {
          alert('Voice recording is too large to store in Firestore.');
          return;
        }

        const reader = new FileReader();

        reader.onloadend = async () => {
          try {
            await sendMessage({
              type: 'audio',
              url: reader.result
            });
          } catch {
            alert('Voice message could not be sent.');
          }
        };

        reader.readAsDataURL(blob);
      } catch (error) {
        console.error(error);
        alert('Could not process voice recording.');
      }
    };

    recorder.start();

    alert('Recording started. Press OK to stop recording.');

    setTimeout(() => {
      if (recorder?.state === 'recording') recorder.stop();
    }, 10000);
  } catch (error) {
    console.error(error);
    alert('Microphone permission is required.');
  }
}

function showProfile(uid) {
  const u = uid === me.uid
    ? {
        name: me.displayName || me.email?.split('@')[0],
        email: me.email,
        ...users[uid]
      }
    : users[uid];

  if (!u) {
    alert('Profile not available.');
    return;
  }

  inProfile = true;

  root.innerHTML = `
    <div class="profile">
      <button id="profileBack" class="icon">← Back</button>

      <div class="profile-card">
        <button id="viewDP" class="dp-view">
          ${avatar(u, 'bigav')}
        </button>

        <h2>${esc(u.name || 'User')}</h2>
        <p>@${esc(u.username || 'No username')}</p>
        <p>${esc(u.email || '')}</p>

        <p>${u.online ? '🟢 Online' : '⚪ Offline'}</p>

        ${uid === me.uid ? `
          <label for="newName">Display name</label>
          <input id="newName"
            value="${esc(u.name || '')}"
            placeholder="Your name" />

          <label for="newDP">Profile photo</label>
          <input id="newDP" type="file" accept="image/*" />

          <button id="saveProfile" class="primary">
            Save profile
          </button>
        ` : `
          <button id="profileChat" class="primary">
            Message
          </button>

          <button id="profileAudio" class="primary">
            📞 Audio call
          </button>

          <button id="profileVideo" class="primary">
            📹 Video call
          </button>
        `}
      </div>
    </div>`;

  root.querySelector('#profileBack').onclick = () => {
    inProfile = false;

    if (currentChat) {
      renderChat();
    } else {
      renderHome();
    }
  };

  root.querySelector('#viewDP').onclick = () => {
    if (u.photo) {
      showMedia(u.photo, 'image');
    } else {
      alert('This user has no profile photo.');
    }
  };

  if (uid !== me.uid) {
    root.querySelector('#profileChat').onclick = () => startDM(uid);

    root.querySelector('#profileAudio').onclick = () =>
      startCall(uid, 'audio');

    root.querySelector('#profileVideo').onclick = () =>
      startCall(uid, 'video');

    return;
  }

  root.querySelector('#saveProfile').onclick = async () => {
    const name = root.querySelector('#newName').value.trim();
    const file = root.querySelector('#newDP').files?.[0];

    try {
      const updates = {};

      if (name) {
        updates.name = name;
        await updateProfile(me, { displayName: name });
      }

      if (file) {
        if (!file.type.startsWith('image/')) {
          return alert('Choose an image file.');
        }

        const photo = await compressImage(file);

        if (photo.length > 850000) {
          return alert('Choose a smaller profile image.');
        }

        updates.photo = photo;
      }

      if (Object.keys(updates).length) {
        await updateDoc(doc(db, 'users', me.uid), updates);
        users[me.uid] = { ...users[me.uid], ...updates };
      }

      alert('Profile updated.');
      showProfile(me.uid);
    } catch (error) {
      console.error(error);
      alert('Profile could not be saved. Check Firestore rules.');
    }
  };
}

function showGroupMembers(chat) {
  inProfile = true;

  root.innerHTML = `
    <div class="profile">
      <button id="membersBack" class="icon">← Back</button>

      <h2>${esc(chat.name || 'Group')}</h2>
      <p>${chat.members.length} members</p>

      <div class="contact-list">
        ${chat.members.map(uid => {
          const u = users[uid] || {};
          return `
            <button class="chat-row" data-member="${esc(uid)}">
              ${avatar(u)}
              <span>
                ${esc(u.name || u.email || 'Member')}
                ${uid === chat.createdBy ? ' 👑' : ''}
              </span>
            </button>`;
        }).join('')}
      </div>
    </div>`;

  root.querySelector('#membersBack').onclick = () => {
    inProfile = false;
    renderChat();
  };

  root.querySelectorAll('[data-member]').forEach(btn => {
    btn.onclick = () => showProfile(btn.dataset.member);
  });
}

// ========================================
// DAN CHAT - REAL WEBRTC AUDIO/VIDEO CALLS
// ========================================

let activeCallId = null;
let activePC = null;
let localStream = null;
let remoteStream = null;
let callUnsubs = [];
let incomingCallIds = new Set();

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function listenCall(path, callback) {
  const unsub = onSnapshot(path, callback, error => {
    console.error('Call listener error:', error);
  });

  callUnsubs.push(unsub);
}

function stopCallListeners() {
  callUnsubs.forEach(unsub => unsub());
  callUnsubs = [];
}

function cleanupCall() {
  stopCallListeners();

  if (activePC) {
    activePC.close();
    activePC = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }

  activeCallId = null;

  const overlay = document.querySelector('#realCallOverlay');
  if (overlay) overlay.remove();
}

function createCallScreen(type, title, incoming = false) {
  const old = document.querySelector('#realCallOverlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'realCallOverlay';

  overlay.style.cssText = `
    position:fixed;
    inset:0;
    z-index:10000;
    background:#101820;
    color:white;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:16px;
    padding:20px;
    text-align:center;
    font-family:system-ui;
  `;

  overlay.innerHTML = `
    <h2>${esc(title)}</h2>
    <p id="callStatus">
      ${incoming ? 'Incoming call...' : 'Connecting...'}
    </p>

    <video id="remoteVideo"
      autoplay playsinline
      style="width:100%;max-width:500px;max-height:55vh;background:#222;border-radius:12px;${type === 'video' ? '' : 'display:none'}">
    </video>

    <video id="localVideo"
      autoplay playsinline muted
      style="width:130px;max-height:160px;object-fit:cover;background:#333;border-radius:12px;${type === 'video' ? '' : 'display:none'}">
    </video>

    <audio id="remoteAudio" autoplay></audio>

    <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
      ${incoming ? `
        <button id="acceptCall"
          style="padding:13px 22px;border:0;border-radius:24px;background:#16a34a;color:white">
          Accept
        </button>
      ` : ''}

      <button id="muteCall"
        style="padding:13px 22px;border:0;border-radius:24px;background:#444;color:white">
        🎙️ Mute
      </button>

      ${type === 'video' ? `
        <button id="cameraCall"
          style="padding:13px 22px;border:0;border-radius:24px;background:#444;color:white">
          📷 Camera off
        </button>
      ` : ''}

      <button id="endRealCall"
        style="padding:13px 22px;border:0;border-radius:24px;background:#dc2626;color:white">
        End call
      </button>
    </div>
  `;

  document.body.append(overlay);

  const muteButton = overlay.querySelector('#muteCall');

  muteButton.onclick = () => {
    if (!localStream) return;

    const track = localStream.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    muteButton.textContent = track.enabled ? '🎙️ Mute' : '🔇 Unmute';
  };

  const cameraButton = overlay.querySelector('#cameraCall');

  if (cameraButton) {
    cameraButton.onclick = () => {
      if (!localStream) return;

      const track = localStream.getVideoTracks()[0];
      if (!track) return;

      track.enabled = !track.enabled;

      cameraButton.textContent = track.enabled
        ? '📷 Camera off'
        : '📷 Camera on';
    };
  }

  overlay.querySelector('#endRealCall').onclick = endCall;

  return overlay;
}

async function getCallMedia(type) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera/microphone unavailable. Open DAN Chat using HTTPS.'
    );
  }

  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: type === 'video'
      ? { facingMode: 'user' }
      : false
  });
}

function attachCallMedia(pc, stream, overlay, type) {
  remoteStream = new MediaStream();

  stream.getTracks().forEach(track => {
    pc.addTrack(track, stream);
  });

  pc.ontrack = event => {
    event.streams[0]?.getTracks().forEach(track => {
      if (!remoteStream.getTracks().some(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });

    const remoteVideo = overlay.querySelector('#remoteVideo');
    const remoteAudio = overlay.querySelector('#remoteAudio');

    if (type === 'video') {
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(() => {});
    } else {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(() => {});
    }

    const status = overlay.querySelector('#callStatus');
    if (status) status.textContent = 'Connected';
  };

  const localVideo = overlay.querySelector('#localVideo');

  if (type === 'video') {
    localVideo.srcObject = stream;
    localVideo.play().catch(() => {});
  }
}

async function startCall(targetUid, type) {
  if (!me || !targetUid || targetUid === me.uid) return;

  if (activeCallId) {
    alert('A call is already active.');
    return;
  }

  let callRef;

  try {
    localStream = await getCallMedia(type);

    const target = users[targetUid] || {};
    const title = target.name || target.email || 'Contact';

    const overlay = createCallScreen(type, title);

    activePC = new RTCPeerConnection(rtcConfig);

    attachCallMedia(activePC, localStream, overlay, type);

    callRef = doc(collection(db, 'calls'));
    activeCallId = callRef.id;

    activePC.onicecandidate = async event => {
      if (!event.candidate || !activeCallId) return;

      try {
        await addDoc(
          collection(db, 'calls', activeCallId, 'callerCandidates'),
          event.candidate.toJSON()
        );
      } catch (error) {
        console.error('Could not send ICE candidate:', error);
      }
    };

    const offer = await activePC.createOffer();
    await activePC.setLocalDescription(offer);

    await setDoc(callRef, {
      callerId: me.uid,
      calleeId: targetUid,
      type,
      offer: {
        type: offer.type,
        sdp: offer.sdp
      },
      answer: null,
      status: 'ringing',
      createdAt: serverTimestamp()
    });

    listenCall(callRef, async snapshot => {
      if (!snapshot.exists()) return;

      const data = snapshot.data();

      if (
        data.answer &&
        activePC &&
        !activePC.currentRemoteDescription
      ) {
        await activePC.setRemoteDescription(
          new RTCSessionDescription(data.answer)
        );
      }

      if (data.status === 'ended' || data.status === 'rejected') {
        cleanupCall();
      }
    });

    listenCall(
      collection(db, 'calls', callRef.id, 'calleeCandidates'),
      snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type !== 'added' || !activePC) return;

          activePC.addIceCandidate(
            new RTCIceCandidate(change.doc.data())
          ).catch(console.error);
        });
      }
    );

    overlay.querySelector('#callStatus').textContent =
      `Calling ${title}...`;

  } catch (error) {
    console.error('Call start error:', error);

    if (callRef) {
      await updateDoc(callRef, { status: 'ended' }).catch(() => {});
    }

    cleanupCall();

    alert(
      error.message ||
      'Could not start call. Check camera permissions and Firestore rules.'
    );
  }
}

async function receiveCall(callId, data) {
  if (!me || activeCallId) return;

  if (incomingCallIds.has(callId)) return;
  incomingCallIds.add(callId);

  const caller = users[data.callerId] || {};
  const title = caller.name || caller.email || 'Contact';

  const overlay = createCallScreen(data.type, title, true);

  overlay.querySelector('#callStatus').textContent =
    `Incoming ${data.type} call`;

  // If the caller hangs up before we answer, close the incoming screen.
  listenCall(doc(db, 'calls', callId), snapshot => {
    const status = snapshot.data()?.status;

    if (status === 'ended' || status === 'rejected') {
      cleanupCall();
    }
  });

  overlay.querySelector('#acceptCall').onclick = async () => {
    try {
      if (activeCallId) return;

      activeCallId = callId;

      const callRef = doc(db, 'calls', callId);

      const fresh = await getDoc(callRef);
      if (!fresh.exists() || fresh.data().status !== 'ringing') {
        cleanupCall();
        return alert('This call is no longer available.');
      }

      localStream = await getCallMedia(data.type);

      activePC = new RTCPeerConnection(rtcConfig);

      attachCallMedia(activePC, localStream, overlay, data.type);

      activePC.onicecandidate = async event => {
        if (!event.candidate || !activeCallId) return;

        await addDoc(
          collection(db, 'calls', callId, 'calleeCandidates'),
          event.candidate.toJSON()
        ).catch(console.error);
      };

      await activePC.setRemoteDescription(
        new RTCSessionDescription(fresh.data().offer)
      );

      const answer = await activePC.createAnswer();
      await activePC.setLocalDescription(answer);

      await updateDoc(callRef, {
        answer: {
          type: answer.type,
          sdp: answer.sdp
        },
        status: 'answered'
      });

      listenCall(
        collection(db, 'calls', callId, 'callerCandidates'),
        snapshot => {
          snapshot.docChanges().forEach(change => {
            if (change.type !== 'added' || !activePC) return;

            activePC.addIceCandidate(
              new RTCIceCandidate(change.doc.data())
            ).catch(console.error);
          });
        }
      );

      const acceptButton = overlay.querySelector('#acceptCall');
      if (acceptButton) acceptButton.remove();

      overlay.querySelector('#callStatus').textContent = 'Connecting...';

    } catch (error) {
      console.error('Accept call error:', error);
      cleanupCall();

      alert(
        error.message ||
        'Could not accept call. Check microphone/camera permissions.'
      );
    }
  };

  overlay.querySelector('#endRealCall').onclick = async () => {
    await updateDoc(doc(db, 'calls', callId), {
      status: 'rejected'
    }).catch(() => {});

    cleanupCall();
  };
}

async function endCall() {
  const id = activeCallId;

  if (id) {
    await updateDoc(doc(db, 'calls', id), {
      status: 'ended'
    }).catch(console.error);
  }

  cleanupCall();
}

// Listen for incoming calls when signed in.
function watchIncomingCalls() {
  if (!me) return;

  const q = query(
    collection(db, 'calls'),
    where('calleeId', '==', me.uid),
    where('status', '==', 'ringing')
  );

  const unsub = onSnapshot(q, snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== 'added') return;

      const data = change.doc.data();

      if (data.callerId === me.uid) return;

      watchUser(data.callerId);
      receiveCall(change.doc.id, data);
    });
  }, error => {
    console.error('Incoming call listener error:', error);
  });

  unsubs.push(unsub);
}

// Start application
renderAuth();