// --- FIREBASE IMPORTS ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- PRO PLUS SCRIPT (UPGRADED & FIXED) ---

// --- Core Variables ---
const GEMINI_API_KEY = "AIzaSyAThiqodRdUJCmqfJc-6ddrglcpPBU7hT0"; // Provided by environment
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;

let proData = {};
let charts = { consistencyChart: null };
let threeJS = { scene: null, camera: null, renderer: null, animator: null, objects: {}, mouse: new THREE.Vector2(-100, -100) };
let clockInterval = null;
let soundManager = {};
let firebase = { app: null, db: null, auth: null, userId: null, dataUnsubscribe: null };
let isFirebaseReady = false; // Ensures Firebase is loaded before cloud writes
let isInitialLoad = true;

// State for Utilities
let timer = { interval: null, endTime: 0, paused: false, duration: 0 };
let stopwatch = { interval: null, startTime: 0, elapsed: 0, running: false, laps: [] };

const defaultProData = {
    settings: { theme: 'pro-plus-theme', sounds: true, userName: "" },
    schedule: {
        monday: { day: "Monday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        tuesday: { day: "Tuesday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        wednesday: { day: "Wednesday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        thursday: { day: "Thursday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        friday: { day: "Friday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        saturday: { day: "Saturday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] },
        sunday: { day: "Sunday", classes: [], gym: { id: '', title: "", time: "", workout: [] }, otherTasks: [] }
    },
    habits: [
        { id: 'habit-1', text: 'Read 10 Pages', streak: 5, priority: 3, history: [] },
        { id: 'habit-2', text: 'Code for 1 hour', streak: 25, priority: 5, history: [] },
        { id: 'habit-3', text: 'Meditate 10 mins', streak: 12, priority: 2, history: [] },
        { id: 'habit-4', text: 'Drink 3L Water', streak: 3, priority: 1, history: [] },
    ],
    projects: [
        { id: `proj-1`, name: "Personal Website", status: 'active', description: "Create a new portfolio using Three.js and modern CSS.", deadline: "2025-10-31", tasks: [{ id: `task-1`, text: "Design wireframes", done: true, priority: 3 }, { id: `task-2`, text: "Develop landing page", done: false, priority: 2 }] },
        { id: `proj-2`, name: "AI Productivity App", status: 'active', description: "Build a prototype for a voice-controlled dashboard.", deadline: "2025-12-15", tasks: [{ id: `task-3`, text: "Setup database schema", done: true, priority: 3 }, { id: `task-4`, text: "Implement voice commands", done: false, priority: 2 }, { id: `task-5`, text: "Deploy to test server", done: false, priority: 1 }] }
    ],
    journal: "",
    lastUpdated: new Date().toISOString(),
};

// --- SECURITY UTILITIES ---
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- UTILITIES ---
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

const throttledSave = debounce(syncDataWithFirestore, 1000);

// --- SOUND ENGINE ---
function initSoundManager() {
    // [FIX 3] Guard against Tone.js not being loaded yet
    if (typeof Tone === 'undefined') {
        soundManager.playSound = () => {};
        return;
    }
    const createSynth = (volume = -12) => new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.5 } }).toDestination().set({ volume });
    soundManager.uiClick = createSynth(-15);
    soundManager.taskComplete = createSynth(-10);
    soundManager.modalOpen = createSynth(-18);
    soundManager.tabChange = createSynth(-20);
    soundManager.error = createSynth(-10);
    soundManager.timerAlarm = createSynth(-5);

    soundManager.playSound = (sound, note = 'C4', duration = '8n') => {
        if (!proData.settings?.sounds || !soundManager[sound]) return;
        Tone.start();
        soundManager[sound].triggerAttackRelease(note, duration);
    };

    document.body.addEventListener('click', (e) => {
        if (e.target.closest('button, .nav-btn, .checkbox-custom, .is-clickable')) {
            soundManager.playSound('uiClick', 'C3');
        }
    }, true);
}

// --- DATA PERSISTENCE (HYBRID LOCAL + FIREBASE) ---
function saveData() {
    try {
        localStorage.setItem('proPlusData', JSON.stringify(proData));
    } catch (e) {
        console.error("Error saving data to localStorage:", e);
    }
    throttledSave();
}

async function syncDataWithFirestore() {
    if (!firebase.userId || !isFirebaseReady) {
        if (!isFirebaseReady) console.log("Firebase not ready, skipping cloud sync.");
        return;
    }
    const syncStatusEl = document.getElementById('sync-status');
    const syncIndicatorEl = document.getElementById('sync-indicator');
    const lastSyncedEl = document.getElementById('last-synced');

    if (syncStatusEl) syncStatusEl.textContent = "Syncing...";
    if (syncIndicatorEl) syncIndicatorEl.classList.add('syncing');

    try {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const docRef = doc(firebase.db, `artifacts/${appId}/users/${firebase.userId}/proPlusData`);
        proData.lastUpdated = new Date().toISOString();
        await setDoc(docRef, proData, { merge: true });
        if (syncStatusEl) syncStatusEl.textContent = "Synced";
        if (lastSyncedEl) lastSyncedEl.textContent = `Last: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        console.error("Error syncing data to Firestore:", error);
        if (syncStatusEl) syncStatusEl.textContent = "Error";
    } finally {
        if (syncIndicatorEl) setTimeout(() => syncIndicatorEl.classList.remove('syncing'), 500);
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initSoundManager();
    initializeFirebase();
    bindUniversalEventListeners();
    setupSwipeNavigation();
});

function initializeFirebase() {
    try {
        const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
        firebase.app = initializeApp(firebaseConfig);
        firebase.db = getFirestore(firebase.app);
        firebase.auth = getAuth(firebase.app);

        onAuthStateChanged(firebase.auth, async (user) => {
            if (user) {
                firebase.userId = user.uid;
                await setupDataListener();
            } else {
                const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
                try {
                    if (token) {
                        await signInWithCustomToken(firebase.auth, token);
                    } else {
                        await signInAnonymously(firebase.auth);
                    }
                } catch (e) {
                    console.error("Authentication failed, falling back to anonymous", e);
                    await signInAnonymously(firebase.auth);
                }
            }
        });
    } catch (e) {
        console.error("Firebase initialization failed. Using local fallback.", e);
        isFirebaseReady = false;
        loadDataFromLocalStorage();
        initializeAppUI();
    }
}

function loadDataFromLocalStorage() {
    try {
        const localData = localStorage.getItem('proPlusData');
        if (localData) {
            proData = JSON.parse(localData);
            console.log("Loaded data from local backup.");
        } else {
            proData = JSON.parse(JSON.stringify(defaultProData));
            console.log("No local backup found. Initializing with default data.");
        }
    } catch (e) {
        console.error("Failed to load or parse local data. Using default data.", e);
        proData = JSON.parse(JSON.stringify(defaultProData));
    }
}


async function setupDataListener() {
    if (firebase.dataUnsubscribe) firebase.dataUnsubscribe();

    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const docRef = doc(firebase.db, `artifacts/${appId}/users/${firebase.userId}/proPlusData`);

    firebase.dataUnsubscribe = onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
            console.log("Loaded data from Firestore.");
            const remoteData = docSnap.data();
            // [FIX] Perform a deep merge to ensure new default properties are added
            proData = {
                ...JSON.parse(JSON.stringify(defaultProData)),
                ...remoteData,
                settings: { ...defaultProData.settings, ...(remoteData.settings || {}) },
                schedule: { ...defaultProData.schedule, ...(remoteData.schedule || {}) },
            };
            // Ensure nested schedule objects are fully populated to prevent errors
            Object.keys(defaultProData.schedule).forEach(day => {
                proData.schedule[day] = { ...defaultProData.schedule[day], ...(proData.schedule[day] || {}) };
                proData.schedule[day].gym = { ...defaultProData.schedule[day].gym, ...(proData.schedule[day].gym || {}) };
                proData.schedule[day].classes = proData.schedule[day].classes || [];
                proData.schedule[day].otherTasks = proData.schedule[day].otherTasks || [];
                proData.schedule[day].gym.workout = proData.schedule[day].gym.workout || [];
            });
            localStorage.setItem('proPlusData', JSON.stringify(proData));
        } else {
            console.log("No data in Firestore. Checking local backup.");
            loadDataFromLocalStorage();
            isFirebaseReady = true;
            saveData(); // Save local/default data to create the Firestore document
        }

        if (isInitialLoad) {
            initializeAppUI();
            isInitialLoad = false;
        } else {
            // If data changes from another source, refresh the current view
            const currentTab = document.querySelector('.nav-btn.active')?.dataset.tab;
            if (currentTab) {
                window.changeTab(currentTab, true); // `true` prevents sound playing on auto-refresh
            }
        }
        isFirebaseReady = true;
    }, (error) => {
        console.error("Error listening to Firestore. Falling back to local data.", error);
        isFirebaseReady = false;
        loadDataFromLocalStorage();
        if (isInitialLoad) {
            initializeAppUI();
            isInitialLoad = false;
        }
    });
}

function initializeAppUI() {
    applyTheme(true);
    window.changeTab('dashboard');
}

// [FIX 2] Add defensive event binding to avoid null reference errors
function bindUniversalEventListeners() {
    const on = (id, evt, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(evt, handler);
    };

    on('project-form', 'submit', handleProjectFormSubmit);
    on('task-form', 'submit', handleTaskFormSubmit);
    on('habit-form', 'submit', handleHabitFormSubmit);
    on('schedule-event-form', 'submit', handleScheduleEventFormSubmit);

    // Existing delegated listeners remain as-is, but with optional chaining for safety
    const dynamicFields = document.getElementById('event-specific-fields');
    dynamicFields?.addEventListener('click', e => {
        if (e.target.classList.contains('remove-exercise-btn')) {
            e.target.closest('.exercise-field-group')?.remove();
        }
    });

    on('add-exercise-btn', 'click', () => {
        addExerciseField();
    });

    const eventTypeSelect = document.getElementById('schedule-event-type');
    eventTypeSelect?.addEventListener('change', (e) => {
        document.getElementById('class-fields')?.classList.toggle('hidden', e.target.value !== 'class');
        document.getElementById('gym-fields')?.classList.toggle('hidden', e.target.value !== 'gym');
    });

    document.getElementById('confirmation-modal')?.addEventListener('click', (e) => {
        const target = e.target.closest('button');
        if (!target) return;

        if (target.id === 'confirm-btn' && window.confirmAction) window.confirmAction();
        if (target.id === 'merge-btn' && window.importMergeAction) window.importMergeAction();
        if (target.id === 'overwrite-btn' && window.importOverwriteAction) window.importOverwriteAction();

        closeModal('confirmation-modal');
    });

    // Add event listeners for modal closing and Three.js responsiveness
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal(overlay.closest('.modal-container').id);
            }
        });
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-container.visible').forEach(modal => {
                closeModal(modal.id);
            });
        }
    });
    
    window.addEventListener('resize', handleThreeJSResize);
    window.addEventListener('mousemove', handleThreeJSMouseMove);
}


// --- THEME & SETTINGS ---
function applyTheme(isInitialLoad = false) {
    const theme = proData.settings.theme;
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.remove('apple-background');

    // Apply the dynamic background based on the selected theme
    if (theme === 'apple-theme' || theme === 'apple-dark-theme') {
        document.body.classList.add('apple-background');
    }

    const isDashboard = document.querySelector('.nav-btn[data-tab="dashboard"].active');
    if (isDashboard) {
        initDynamicBackground();
    }
}

window.changeTheme = (theme) => {
    proData.settings.theme = theme;
    applyTheme();
    saveData();
    if (charts.consistencyChart) { renderAnalyticsChart(); }
};

window.toggleSounds = (checkbox) => {
    proData.settings.sounds = checkbox.checked;
    saveData();
}

// --- TAB/VIEW MANAGEMENT ---
window.changeTab = (tabName, fromListener = false) => {
    if (!fromListener) soundManager.playSound('tabChange', 'C2');

    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
    if (navBtn) navBtn.classList.add('active');

    const main = document.getElementById('main-content');
    main.innerHTML = '';

    if (clockInterval) clearInterval(clockInterval);
    if (stopwatch.interval) clearInterval(stopwatch.interval);
    if (timer.interval) clearInterval(timer.interval);
    cleanupDynamicBackground();

    switch (tabName) {
        case 'dashboard': renderDashboard(); break;
        case 'projects': renderProjects(); break;
        case 'habits': renderHabitsPage(); break;
        case 'command': renderCommandCenter(); break;
        case 'journal': renderJournal(); break;
        case 'settings': renderSettings(); break;
    }
}
// --- SWIPE NAVIGATION ---
function setupSwipeNavigation() {
    const navBar = document.querySelector('.sidebar-content');
    if (!navBar) return;

    let touchStartX = 0;
    let touchEndX = 0;
    const swipeThreshold = 50; // Minimum distance to consider it a swipe

    navBar.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });

    navBar.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    });

    function handleSwipe() {
        const diff = touchStartX - touchEndX;
        if (Math.abs(diff) > swipeThreshold) {
            const navButtons = Array.from(document.querySelectorAll('.nav-btn'));
            const activeNavButton = document.querySelector('.nav-btn.active');
            const currentIndex = navButtons.findIndex(btn => btn === activeNavButton);

            if (diff > 0) { // Swiped left
                const nextIndex = (currentIndex + 1) % navButtons.length;
                window.changeTab(navButtons[nextIndex].dataset.tab);
            } else { // Swiped right
                const prevIndex = (currentIndex - 1 + navButtons.length) % navButtons.length;
                window.changeTab(navButtons[prevIndex].dataset.tab);
            }
        }
    }
}

// --- DASHBOARD: SMART LAYOUT ---
function getSmartLayout() {
    let components = [
        { id: 'agenda', priority: 10, component: renderAgendaCard, width: 2, height: 2, focus: true },
        { id: 'utilities', priority: 8, component: renderUtilitiesCard, width: 2, height: 2, focus: true },
        { id: 'habits', priority: 7, component: renderHabitsOverviewCard, width: 2, height: 1 },
        { id: 'analytics', priority: 6, component: renderAnalyticsCard, width: 2, height: 1 },
    ];

    return components.sort((a, b) => b.priority - a.priority);
}

function getGreeting() {
    const hour = new Date().getHours();
    const userName = proData.settings?.userName;
    const greeting = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";
    return `${greeting}${userName ? `, ${escapeHtml(userName)}` : ''}`;
}


function updateClock() {
    const dateEl = document.getElementById('current-date');
    const timeEl = document.getElementById('current-time');
    if (dateEl && timeEl) {
        const now = new Date();
        dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        timeEl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
}

window.toggleFocusMode = () => {
    document.body.classList.toggle('focus-mode');
    soundManager.playSound('uiClick', document.body.classList.contains('focus-mode') ? 'E4' : 'C4');
}

function renderDashboard() {
    const main = document.getElementById('main-content');
    const themeOptions = [
        { value: 'pro-plus-theme', text: 'Pro Plus' },
        { value: 'synthwave-theme', text: 'Synthetic' },
        { value: 'dark-theme', text: 'Dark' },
        { value: 'apple-theme', text: 'Apple' },
        { value: 'apple-dark-theme', text: 'Apple Dark' }
    ].map(opt => `<option value="${opt.value}" ${proData.settings.theme === opt.value ? 'selected' : ''}>${opt.text}</option>`).join('');

    main.innerHTML = `
        <header class="flex flex-wrap items-center justify-between mb-6 gap-4">
            <div>
                <h1 class="text-3xl sm:text-4xl font-bold text-header tracking-tight">${getGreeting()}</h1>
                <div class="flex items-center text-md text-secondary">
                    <span id="current-date"></span><span class="mx-2">|</span><span id="current-time"></span>
                    <span class="mx-2">|</span>
                    <div id="sync-indicator" class="sync-indicator flex items-center text-xs">
                        <svg class="sync-icon h-4 w-4 mr-1 md:mr-2" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                        <div class="hidden md:inline">
                            <span id="sync-status" class="ml-1 font-bold">Waiting...</span>
                            <span id="last-synced" class="ml-2 text-xs opacity-70"></span>
                        </div>
                    </div>
                </div>
            </div>
            <div id="dashboard-controls" class="flex items-center gap-2 md:gap-4">
                 <div class="control-group theme-control">
                      <select id="theme-dashboard-select" onchange="changeTheme(this.value)" class="pro-input !text-sm !p-2 !pr-8">${themeOptions}</select>
                 </div>
                <button onclick="toggleFocusMode()" class="secondary-btn focus-control" title="Toggle Focus Mode">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><circle cx="12" cy="12" r="3"></circle><path d="M7 12h-4"></path><path d="M12 7V3"></path><path d="M17 12h4"></path><path d="M12 17v4"></path></svg>
                    <span class="hidden md:inline">Focus</span>
                </button>
            </div>
        </header>
        <div id="smart-layout-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 auto-rows-[220px]"></div>
    `;
    updateClock();
    clockInterval = setInterval(updateClock, 1000);

    const grid = document.getElementById('smart-layout-grid');
    const layout = getSmartLayout();
    layout.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = `glass-card p-4 lg:p-6 no-hover`;
        if (item.id === 'agenda') {
            card.classList.add('is-clickable');
            card.classList.remove('no-hover');
            card.setAttribute('onclick', 'openScheduleModal()');
        }
        if (item.focus) card.classList.add('focus-priority');
        card.style.gridColumn = `span ${item.width}`;
        card.style.gridRow = `span ${item.height}`;
        card.style.setProperty('--animation-delay', `${index * 100}ms`);
        card.innerHTML = item.component(item);
        grid.appendChild(card);

        if (item.id === 'analytics') {
            setTimeout(() => renderAnalyticsChart(), 100);
        }
    });

    initDynamicBackground();
}

function renderAgendaCard() {
    const todayKey = new Date().toLocaleDateString('en-us', { weekday: 'long' }).toLowerCase();
    const todaySchedule = proData.schedule[todayKey] || { classes: [], gym: {}, otherTasks: [] };
    let content = '<p class="text-secondary flex items-center justify-center h-full">No events scheduled for today.</p>';

    const events = [
        ...(todaySchedule.classes || []).map(c => ({ ...c, type: 'class' })),
        ...(todaySchedule.otherTasks || []).map(t => ({ ...t, type: 'otherTask' })),
        ...(todaySchedule.gym?.title ? [{ ...todaySchedule.gym, name: todaySchedule.gym.title, type: 'gym' }] : [])
    ].sort((a, b) => {
        const timeA = (a.time || "00:00").split(/\s*-\s*/)[0].trim();
        const timeB = (b.time || "00:00").split(/\s*-\s*/)[0].trim();
        // Sort by numerical time to handle '9:00' correctly before '10:00'
        return timeA.localeCompare(timeB, undefined, { numeric: true, sensitivity: 'base' });
    });

    if (events.length > 0) {
        content = `<div class="space-y-3 overflow-y-auto h-full max-h-[calc(100%-2rem)] pr-2">${events.map(event => `
            <div class="flex items-center text-sm">
                <span class="font-semibold w-24">${escapeHtml((event.time || "00:00-00:00").split(/\s*-\s*/)[0].trim())}</span>
                <span class="h-4 w-px bg-[--card-border] mx-4"></span>
                <div class="flex-grow">
                    <p>${escapeHtml(event.name)}</p>
                    ${event.location ? `<p class="text-xs text-secondary">${escapeHtml(event.location)}</p>` : ''}
                </div>
            </div>
        `).join('')}</div>`;
    }
    return `
        <h3 class="text-xl font-semibold text-header mb-4">Today's Agenda</h3>
        <div class="flex-grow relative">${content}</div>
    `;
}

// Habits overview card for the dashboard
function renderHabitsOverviewCard() {
    const habits = proData.habits?.sort((a,b) => b.priority - a.priority).slice(0, 4) || [];
    let content;

    if (habits.length === 0) {
        content = `<p class="text-secondary flex items-center justify-center h-full">No habits are being tracked.</p>`;
    } else {
        content = `<div class="grid grid-cols-2 gap-x-6 gap-y-4">
            ${habits.map(habit => {
                const isDone = isHabitDoneToday(habit.id);
                return `
                <label for="dash-habit-${escapeHtml(habit.id)}" class="flex items-center cursor-pointer text-sm">
                    <input type="checkbox" id="dash-habit-${escapeHtml(habit.id)}" ${isDone ? 'checked' : ''} onchange="toggleHabit('${escapeHtml(habit.id)}')" class="hidden">
                    <span class="checkbox-custom ${isDone ? 'checked' : ''}"></span>
                    <span class="ml-2 ${isDone ? 'line-through text-secondary' : ''}">${escapeHtml(habit.text)}</span>
                </label>
                `;
            }).join('')}
        </div>`;
    }

    return `
        <h3 class="text-xl font-semibold text-header mb-4">Daily Habits</h3>
        ${content}
    `;
}


const todayISO = () => new Date().toISOString().split('T')[0];

function isHabitDoneToday(habitId) {
    const habit = proData.habits.find(h => h.id === habitId);
    if (!habit || !habit.history) return false;
    return habit.history.some(entry => entry.date === todayISO() && entry.done);
}

/**
 * Recalculates the streak for a habit based on its history.
 * @param {object} habit - The habit object with a history array.
 * @returns {number} The calculated streak count.
 */
function recalculateStreak(habit) {
    if (!habit.history || habit.history.length === 0) return 0;

    const doneDates = [...new Set(
        habit.history
            .filter(entry => entry.done)
            .map(entry => {
                const date = new Date(entry.date);
                date.setUTCHours(12, 0, 0, 0);
                return date.getTime();
            })
    )].map(t => new Date(t)).sort((a, b) => b - a);

    if (doneDates.length === 0) return 0;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const dayDiffFromToday = Math.floor((today.getTime() - doneDates[0].getTime()) / (1000 * 60 * 60 * 24));
    if (dayDiffFromToday > 1) {
        return 0; 
    }

    let streak = 0;
    if (doneDates.length > 0) {
        streak = 1;
        for (let i = 1; i < doneDates.length; i++) {
            const dayDifference = Math.floor((doneDates[i-1].getTime() - doneDates[i].getTime()) / (1000 * 60 * 60 * 24));
            if (dayDifference === 1) {
                streak++;
            } else {
                break;
            }
        }
    }

    return streak;
}


window.toggleHabit = (id) => {
    const habit = proData.habits.find(h => h.id === id);
    if (habit) {
        const todayStr = todayISO();
        let todayEntry = habit.history?.find(e => e.date === todayStr);

        if (todayEntry) {
            todayEntry.done = !todayEntry.done;
        } else {
            if (!habit.history) habit.history = [];
            habit.history.push({ date: todayStr, done: true });
        }

        habit.streak = recalculateStreak(habit);

        soundManager.playSound('taskComplete', todayEntry?.done ?? true ? 'G4' : 'G3');

        updateAndRefreshHabits();
    }
}

function updateAndRefreshHabits() {
    saveData();
    if (document.getElementById('habits-page-container')) {
        renderHabitListForPage();
    }

    const dashboardGrid = document.getElementById('smart-layout-grid');
    if (dashboardGrid) {
        const habitsCard = Array.from(dashboardGrid.children).find(card => card.querySelector('h3')?.textContent === "Daily Habits");
        if(habitsCard) {
            habitsCard.innerHTML = renderHabitsOverviewCard();
        }
        const analyticsCard = Array.from(dashboardGrid.children).find(card => card.querySelector('h3')?.textContent === "Weekly Analytics");
        if(analyticsCard) {
             renderAnalyticsChart();
        }
    }
}

function renderAnalyticsCard() {
    return `
        <h3 class="text-xl font-semibold text-header mb-4">Weekly Analytics</h3>
        <div class="flex-grow relative h-[calc(100%-40px)]">
            <canvas id="consistency-chart"></canvas>
        </div>
    `;
}

function renderAnalyticsChart() {
    const ctx = document.getElementById('consistency-chart');
    if (!ctx) return;
    if (charts.consistencyChart) charts.consistencyChart.destroy();

    const labels = [];
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
        const dateStr = d.toISOString().split('T')[0];

        const totalHabits = proData.habits.length;
        if (totalHabits === 0) {
            data.push(0);
            continue;
        }
        const completedHabits = proData.habits.filter(h => h.history?.some(e => e.date === dateStr && e.done)).length;
        data.push((completedHabits / totalHabits) * 100);
    }
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();
    const accentColorSecondary = getComputedStyle(document.documentElement).getPropertyValue('--accent-color-secondary').trim();

    charts.consistencyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Habit Consistency',
                data,
                backgroundColor: data.map(d => d === 100 ? accentColor : accentColorSecondary + '80'),
                borderColor: accentColor,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, max: 100, grid: { color: 'rgba(0,0,0,0.1)' }, ticks: { color: 'var(--text-secondary)', callback: val => val + '%' } },
                x: { grid: { display: false }, ticks: { color: 'var(--text-secondary)' } }
            },
            plugins: { legend: { display: false }, tooltip: { enabled: true, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(0)}%` } } }
        }
    });
}

// --- DYNAMIC BACKGROUNDS ---
function handleThreeJSResize() {
    if (!threeJS.camera || !threeJS.renderer) return;
    threeJS.camera.aspect = window.innerWidth / window.innerHeight;
    threeJS.camera.updateProjectionMatrix();
    threeJS.renderer.setSize(window.innerWidth, window.innerHeight);
    threeJS.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}
function handleThreeJSMouseMove(event) {
    if (!threeJS.renderer) return; // Guard against unnecessary work
    threeJS.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    threeJS.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function cleanupDynamicBackground() {
    if (threeJS.animator) {
        cancelAnimationFrame(threeJS.animator);
        threeJS.animator = null;
    }
    if (threeJS.renderer) {
        threeJS.renderer.domElement.remove();
        threeJS.renderer.dispose();
        threeJS.renderer = null;
    }
    document.getElementById('deep-sea-particles')?.remove();
    document.getElementById('synthwave-grid')?.remove();
}

// [FIX 3] Guard against external libraries not being loaded yet
function initDynamicBackground() {
    if (threeJS.renderer) return; // Add guard to prevent duplicate initialization
    cleanupDynamicBackground();
    const theme = proData.settings.theme;

    // Skip heavy scenes on small screens
    if (window.innerWidth <= 768) {
        const heavyThemes = ['pro-plus-theme', 'synthwave-theme'];
        if (heavyThemes.includes(theme)) {
            return;
        }
    }

    if (typeof THREE === 'undefined') {
      // Library not yet available; skip initializing until next tab render
      return;
    }

    switch (theme) {
        case 'pro-plus-theme':
        case 'dark-theme': 
        case 'synthwave-theme': initParticleScene(); break;
        // Apple theme has no animated background, so we do nothing here.
        case 'apple-theme':
        case 'apple-dark-theme':
            // The class is added/removed in applyTheme, so no action needed here.
            break;
    }
}

function initParticleScene() {
    const container = document.body;
    threeJS.scene = new THREE.Scene();
    threeJS.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    threeJS.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    threeJS.renderer.setSize(window.innerWidth, window.innerHeight);
    threeJS.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    threeJS.renderer.domElement.className = 'three-canvas';
    container.prepend(threeJS.renderer.domElement);
    threeJS.camera.position.z = 15;

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-color-secondary').trim();
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(5000 * 3);
    for (let i = 0; i < 5000 * 3; i++) positions[i] = (Math.random() - 0.5) * 30;
    particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const particleMaterial = new THREE.PointsMaterial({
        color: accentColor, size: 0.05, transparent: true, blending: THREE.AdditiveBlending,
    });
    threeJS.objects.particles = new THREE.Points(particles, particleMaterial);
    threeJS.scene.add(threeJS.objects.particles);

    const clock = new THREE.Clock();
    function animateParticles() {
        threeJS.animator = requestAnimationFrame(animateParticles);
        const elapsedTime = clock.getElapsedTime();
        threeJS.objects.particles.rotation.y = elapsedTime * 0.05;
        threeJS.objects.particles.rotation.x += (threeJS.mouse.y * 0.2 - threeJS.objects.particles.rotation.x) * 0.05;
        threeJS.objects.particles.rotation.y += (threeJS.mouse.x * 0.2 - threeJS.objects.particles.rotation.y) * 0.05;
        threeJS.renderer.render(threeJS.scene, threeJS.camera);
    }
    animateParticles();
}


// --- PROJECTS PAGE ---
function updateAndRefreshProjects() {
    if (document.getElementById('projects-container')) {
        handleFilterSortChange();
    }
    saveData();
}

function renderProjects() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <header class="flex flex-wrap items-center justify-between mb-6 gap-4">
            <h1 class="text-3xl sm:text-4xl font-semibold text-header tracking-tight">Projects</h1>
            <div class="flex items-center gap-2">
                <select id="project-status-filter" onchange="handleFilterSortChange()" class="pro-input text-sm">
                    <option value="active">Active</option>
                    <option value="completed">Completed</option>
                    <option value="archived">Archived</option>
                </select>
                <select id="project-sort" onchange="handleFilterSortChange()" class="pro-input text-sm">
                    <option value="deadline">Sort by Deadline</option>
                    <option value="name_asc">Sort by Name (A-Z)</option>
                    <option value="name_desc">Sort by Name (Z-A)</option>
                    <option value="progress">Sort by Progress</option>
                </select>
            </div>
            <button onclick="openModal('project-modal')" class="pro-btn">New Project</button>
        </header>
        <div id="projects-container" class="space-y-6"></div>
    `;
    handleFilterSortChange();
}

window.handleFilterSortChange = () => {
    const container = document.getElementById('projects-container');
    if (!container) return;
    const filterValue = document.getElementById('project-status-filter').value;
    const sortValue = document.getElementById('project-sort').value;

    let projectsToDisplay = (proData.projects || []).filter(p => {
        const progress = p.tasks.length > 0 ? (p.tasks.filter(t => t.done).length / p.tasks.length) * 100 : 0;
        if (filterValue === 'completed') {
            return progress === 100 && p.status === 'active';
        }
        return p.status === filterValue;
    });

    projectsToDisplay.sort((a, b) => {
        switch (sortValue) {
            case 'deadline': return new Date(a.deadline) - new Date(b.deadline);
            case 'name_asc': return a.name.localeCompare(b.name);
            case 'name_desc': return b.name.localeCompare(a.name);
            case 'progress': {
                const progressA = a.tasks.length > 0 ? (a.tasks.filter(t => t.done).length / a.tasks.length) : 0;
                const progressB = b.tasks.length > 0 ? (b.tasks.filter(t => t.done).length / b.tasks.length) : 0;
                return progressB - progressA;
            }
            default: return 0;
        }
    });

    container.innerHTML = '';
    if (projectsToDisplay.length === 0) {
        container.innerHTML = `<div class="glass-card text-center p-8"><p class="text-secondary">No projects match the current filter.</p></div>`;
    } else {
        projectsToDisplay.forEach((p, index) => container.appendChild(createProjectCard(p, index)));
    }
}

function createProjectCard(project, index) {
    const card = document.createElement('div');
    card.className = 'glass-card p-6';
    card.style.setProperty('--animation-delay', `${index * 100}ms`);

    const deadline = new Date(project.deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const timeDiff = deadline.getTime() - today.getTime();
    const dayDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));

    if (project.status === 'active' && dayDiff < 0) {
        card.classList.add('deadline-overdue');
    } else if (project.status === 'active' && dayDiff <= 7) {
        card.classList.add('deadline-warning');
    }

    const progress = project.tasks.length > 0 ? Math.round((project.tasks.filter(t => t.done).length / project.tasks.length) * 100) : 0;

    const tasksHTML = project.tasks.sort((a, b) => b.priority - a.priority).map(task => `
        <div class="flex items-center justify-between py-2 border-b border-[--card-border]">
            <label for="${escapeHtml(task.id)}" class="flex items-center cursor-pointer text-sm">
                <input type="checkbox" id="${escapeHtml(task.id)}" ${task.done ? 'checked' : ''} onchange="toggleProjectTask('${escapeHtml(project.id)}', '${escapeHtml(task.id)}')" class="hidden">
                <span class="checkbox-custom ${task.done ? 'checked' : ''}"></span>
                <span class="priority-indicator priority-${escapeHtml(task.priority)}"></span>
                <span class="${task.done ? 'line-through text-secondary' : ''}">${escapeHtml(task.text)}</span>
            </label>
        </div>
    `).join('');

    let actionButtons = '';
    if (project.status === 'active') {
        actionButtons += `<button onclick='openModal("project-modal", proData.projects.find(p => p.id === "${escapeHtml(project.id)}"))' class="secondary-btn text-xs py-1 px-2">Edit</button>`;
        if (progress === 100) {
            actionButtons += `<button onclick="archiveProject('${escapeHtml(project.id)}')" class="secondary-btn text-xs py-1 px-2 ml-2">Archive</button>`;
        }
        actionButtons += `<button onclick="showConfirmation({ title: 'Delete Project?', message: 'Are you sure you want to delete this project?', confirmText: 'Delete' }, () => deleteProject('${escapeHtml(project.id)}'))" class="danger-btn text-xs py-1 px-2 ml-2">Delete</button>`;
    } else if (project.status === 'archived') {
        actionButtons = `<button onclick="unarchiveProject('${escapeHtml(project.id)}')" class="secondary-btn text-xs py-1 px-2">Restore</button>
                         <button onclick="showConfirmation({ title: 'Delete Permanently?', message: 'This will permanently delete the project and its tasks. This is irreversible.', confirmText: 'Delete' }, () => deleteProject('${escapeHtml(project.id)}'))" class="danger-btn text-xs py-1 px-2 ml-2">Delete Permanently</button>`;
    }


    card.innerHTML = `
        <div class="flex justify-between items-start">
            <div>
                <h3 class="text-xl font-semibold text-header tracking-tight">${escapeHtml(project.name)}</h3>
                <p class="text-sm text-secondary mt-1">${escapeHtml(project.description)}</p>
                <p class="text-xs text-secondary mt-2">Deadline: ${escapeHtml(project.deadline)} ${project.status === 'active' && dayDiff >= 0 ? `(${dayDiff} days left)` : ''}</p>
            </div>
            <div class="flex items-center">
                ${actionButtons}
            </div>
        </div>
        <div class="mt-4">
            <div class="flex justify-between items-baseline mb-1">
                <p class="text-sm">Progress (${project.tasks.filter(t => t.done).length}/${project.tasks.length})</p>
                <p class="text-sm font-semibold">${progress}%</p>
            </div>
            <div class="project-progress-bar"><div class="project-progress-inner" style="width: ${progress}%"></div></div>
        </div>
        <div class="mt-4 space-y-2">${project.status === 'active' ? tasksHTML : '<p class="text-sm text-secondary text-center">Project is archived. Restore to see tasks.</p>'}</div>
        ${project.status === 'active' ? `<button onclick="openModal('task-modal', { projectId: '${escapeHtml(project.id)}' })" class="secondary-btn w-full mt-4 text-sm">Add Task</button>` : ''}
    `;
    return card;
}


// --- COMMAND CENTER ---
function renderCommandCenter() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <header class="mb-6">
            <h1 class="text-3xl sm:text-4xl font-semibold text-header tracking-tight">Command Center</h1>
            <p class="text-md text-secondary">Your AI-powered mission control. Try: "What's my top priority?"</p>
        </header>
        <div class="glass-card h-[calc(100%-120px)] flex flex-col p-4">
            <div id="ai-chat-body" class="flex-grow space-y-4 overflow-y-auto p-4 flex flex-col">
                <div class="ai-message">Hello! I'm your PRO PLUS assistant. How can I help you optimize your day?</div>
            </div>
            <form id="ai-chat-form" class="mt-4 flex gap-4">
                <input id="ai-chat-input" type="text" placeholder="e.g., 'Add task to Personal Website...'" class="pro-input flex-grow">
                <button type="submit" class="pro-btn">Send</button>
            </form>
        </div>
    `;
    document.getElementById('ai-chat-form')?.addEventListener('submit', handleAssistantChat);
}

// --- JOURNAL ---
function renderJournal() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <header class="mb-6">
            <h1 class="text-3xl sm:text-4xl font-semibold text-header tracking-tight">Journal</h1>
            <p class="text-md text-secondary">A secure space for your thoughts.</p>
        </header>
        <div class="glass-card h-[calc(100%-100px)] flex flex-col p-2">
            <textarea id="journal-textarea" class="w-full h-full bg-transparent p-4 text-base leading-relaxed resize-none focus:outline-none" placeholder="Start writing...">${escapeHtml(proData.journal || '')}</textarea>
        </div>
    `;
    const textarea = document.getElementById('journal-textarea');
    let timeout;
    textarea?.addEventListener('keyup', (e) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            proData.journal = e.target.value;
            saveData();
        }, 500);
    });
}

// --- SETTINGS ---
function renderSettings() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <header class="mb-6">
            <h1 class="text-3xl sm:text-4xl font-semibold text-header tracking-tight">Settings</h1>
            <p class="text-md text-secondary">Configure your PRO PLUS experience.</p>
        </header>
        <div class="space-y-6 max-w-2xl">
            <div class="glass-card p-6">
                <h3 class="text-xl font-semibold mb-4 text-[--accent-color]">Personalization</h3>
                <div class="space-y-2">
                    <label for="user-name-input" class="block text-sm font-medium text-secondary">Your Name</label>
                    <input type="text" id="user-name-input" class="pro-input w-full" value="${escapeHtml(proData.settings.userName || '')}" onkeyup="handleUserNameChange(this)" placeholder="Enter your name for greetings">
                </div>
            </div>

            <div class="glass-card p-6">
                <h3 class="text-xl font-semibold mb-4 text-[--accent-color]">Your User ID</h3>
                <p class="text-xs text-secondary mb-2">This is your unique ID for data storage. You can use it to share data in future collaborative features.</p>
                <div class="flex items-center gap-2 p-2 rounded-lg bg-[--bg-primary]">
                    <input type="text" id="user-id-display" readonly value="${escapeHtml(firebase.userId || 'Loading...')}" class="pro-input flex-grow !p-1 !border-0 !bg-transparent">
                    <button id="copy-user-id-btn" onclick="copyUserId()" class="secondary-btn text-xs !py-1 !px-2">Copy</button>
                </div>
            </div>

            <div class="glass-card p-6">
                <h3 class="text-xl font-semibold mb-4 text-[--accent-color]">Sound</h3>
                 <div class="flex items-center justify-between mt-4">
                      <label for="sound-toggle" class="text-sm font-medium text-secondary">Enable Sounds</label>
                      <label class="toggle-switch-label" for="sound-toggle"><input type="checkbox" id="sound-toggle" onchange="toggleSounds(this)" class="toggle-switch"><span class="toggle-switch-slider"></span></label>
                 </div>
            </div>

            <div class="glass-card p-6">
                <h3 class="text-xl font-semibold mb-4 text-[--accent-color]">Data Management</h3>
                <div class="space-y-4">
                        <div>
                            <h4 class="font-semibold mb-2">Import Data</h4>
                            <p class="text-xs text-secondary mb-2">Import a backup file or schedule.</p>
                            <div class="flex gap-2">
                                <label for="import-data-input" class="secondary-btn cursor-pointer w-full text-center">Import JSON</label>
                                <input type="file" id="import-data-input" class="hidden" accept=".json" onchange="importData(event)">
                                 <label for="import-csv-input" class="secondary-btn cursor-pointer w-full text-center">Import CSV</label>
                                <input type="file" id="import-csv-input" class="hidden" accept=".csv" onchange="importScheduleFromCSV(event)">
                            </div>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Export Timetable</h4>
                            <p class="text-xs text-secondary mb-2">Export your weekly schedule.</p>
                            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                <button onclick="exportSchedule('ics')" class="secondary-btn text-sm">ICS</button>
                                <button onclick="exportSchedule('csv')" class="secondary-btn text-sm">CSV</button>
                                <button onclick="exportSchedule('json')" class="secondary-btn text-sm">JSON</button>
                                <button onclick="exportSchedule('pdf')" class="secondary-btn text-sm">PDF</button>
                                <button onclick="exportSchedule('word')" class="secondary-btn text-sm">Word</button>
                            </div>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Export Full Backup</h4>
                            <p class="text-xs text-secondary mb-2">Save a full backup of all your data.</p>
                            <button onclick="exportData()" class="secondary-btn w-full">Export All Data (JSON)</button>
                        </div>
                </div>
            </div>

            <div class="glass-card p-6">
                <h3 class="text-xl font-semibold mb-4 text-[--danger-color]">Danger Zone</h3>
                <button onclick="showConfirmation({ title: 'Confirm Reset', message: 'This will reset all data. This action is irreversible!', confirmText: 'Reset' }, resetAllData)" class="danger-btn w-full">Reset All Data</button>
            </div>
        </div>
    `;
    const soundToggle = document.getElementById('sound-toggle');
    if (soundToggle) {
        soundToggle.checked = proData.settings.sounds;
    }
}

window.copyUserId = () => {
    const userId = firebase.userId;
    const copyBtn = document.getElementById('copy-user-id-btn');
    if (!userId || !copyBtn) {
        console.error("User ID not available to copy.");
        return;
    }

    const showCopiedState = () => {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.disabled = true;
        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.disabled = false;
        }, 2000);
    };

    if (navigator.clipboard) {
        navigator.clipboard.writeText(userId).then(showCopiedState).catch(err => {
            console.error('Failed to copy using Clipboard API, trying fallback: ', err);
            copyToClipboardFallback(userId, showCopiedState);
        });
    } else {
        copyToClipboardFallback(userId, showCopiedState);
    }
}

function copyToClipboardFallback(text, callback) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        callback();
    } catch (err) {
        console.error('Failed to copy using fallback command: ', err);
    } finally {
        document.body.removeChild(textarea);
    }
}


window.showConfirmation = (options, callback) => {
    const { title, message, confirmText, isDanger = true, buttons } = options;

    const confirmationTitleEl = document.getElementById('confirmation-title');
    if (confirmationTitleEl) confirmationTitleEl.textContent = title || 'Confirm Action';

    const confirmationMessageEl = document.getElementById('confirmation-message');
    if (confirmationMessageEl) confirmationMessageEl.textContent = message;

    const buttonsContainer = document.getElementById('confirmation-buttons');

    window.confirmAction = null;
    window.importMergeAction = null;
    window.importOverwriteAction = null;

    if (buttons) {
        buttonsContainer.innerHTML = buttons;
    } else {
        buttonsContainer.innerHTML = `
            <button id="confirm-btn" class="${isDanger ? 'danger-btn' : 'pro-btn'} font-semibold py-2 px-8 rounded-lg">${escapeHtml(confirmText || 'Confirm')}</button>
            <button id="cancel-btn" class="secondary-btn font-semibold py-2 px-8 rounded-lg">Cancel</button>
        `;
        window.confirmAction = callback;
    }

    openModal('confirmation-modal');
}


// --- DATA MANAGEMENT ---
window.exportData = () => {
    const dataStr = JSON.stringify(proData, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pro_plus_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

window.importData = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            if (importedData.settings && importedData.projects && importedData.habits) {
                window.importMergeAction = () => {
                    proData.projects.push(...importedData.projects.filter(p => !proData.projects.some(p2 => p2.id === p.id)));
                    proData.habits.push(...importedData.habits.filter(h => !proData.habits.some(h2 => h2.id === h.id)));
                    if (importedData.journal && !proData.journal) proData.journal = importedData.journal;
                    saveData();
                    initializeAppUI();
                };
                window.importOverwriteAction = () => {
                    proData = importedData;
                    saveData();
                    initializeAppUI();
                };

                showConfirmation({
                    title: 'Import Data',
                    message: 'How would you like to import this data? "Merge" will add new items, while "Overwrite" will replace all existing data.',
                    buttons: `
                        <button id="merge-btn" class="pro-btn font-semibold py-2 px-6 rounded-lg">Merge</button>
                        <button id="overwrite-btn" class="danger-btn font-semibold py-2 px-6 rounded-lg">Overwrite</button>
                        <button id="cancel-btn" class="secondary-btn font-semibold py-2 px-6 rounded-lg">Cancel</button>
                    `
                });
            } else {
                showConfirmation({ title: "Import Failed", message: "The selected file is not a valid PRO PLUS backup.", buttons: `<button id="cancel-btn" class="secondary-btn font-semibold py-2 px-6 rounded-lg">OK</button>` });
                soundManager.playSound('error', 'C3');
            }
        } catch (err) {
            showConfirmation({ title: "Import Failed", message: "There was an error reading the backup file.", buttons: `<button id="cancel-btn" class="secondary-btn font-semibold py-2 px-6 rounded-lg">OK</button>` });
            soundManager.playSound('error', 'C3');
        }
    };
    reader.readAsText(file);
    event.target.value = null;
}


window.resetAllData = () => {
    proData = JSON.parse(JSON.stringify(defaultProData));
    saveData();
    window.changeTab('dashboard', true);
}

// --- SCHEDULE MODAL ---

function refreshDashboardAgenda() {
    const isDashboardActive = document.querySelector('.nav-btn[data-tab="dashboard"].active');
    if (!isDashboardActive) return;

    const allCards = document.querySelectorAll('#smart-layout-grid .glass-card');
    for (const card of allCards) {
        const titleEl = card.querySelector('h3');
        if (titleEl && titleEl.textContent === "Today's Agenda") {
            card.innerHTML = renderAgendaCard();
            break;
        }
    }
}

window.openScheduleModal = () => {
    const modalBody = document.getElementById('schedule-modal-body');
    if (modalBody) {
        modalBody.innerHTML = renderFullScheduleView();
    }
    openModal('schedule-modal');
}

window.openDayViewModal = (dayKey) => {
    const modalBody = document.getElementById('day-view-modal-body');
    const modalTitle = document.getElementById('day-view-modal-title');
    if (modalBody) {
        modalTitle.textContent = `${proData.schedule[dayKey].day}'s Timeline`;
        modalBody.innerHTML = renderDayView(dayKey);
    }
    openModal('day-view-modal');
}

window.openScheduleEventModal = (dayKey, eventType, eventId = null) => {
    const form = document.getElementById('schedule-event-form');
    if(form) form.reset();

    const scheduleDayKeyInput = document.getElementById('schedule-day-key');
    if(scheduleDayKeyInput) scheduleDayKeyInput.value = dayKey;

    const scheduleEventIdInput = document.getElementById('schedule-event-id');
    if(scheduleEventIdInput) scheduleEventIdInput.value = eventId || '';

    const scheduleEventOriginalTypeInput = document.getElementById('schedule-event-original-type');
    if(scheduleEventOriginalTypeInput) scheduleEventOriginalTypeInput.value = eventId ? eventType : '';
    
    const scheduleEventModalTitle = document.getElementById('schedule-event-modal-title');
    if(scheduleEventModalTitle) scheduleEventModalTitle.textContent = eventId ? 'Edit Event' : 'Add Event';

    const eventTypeSelect = document.getElementById('schedule-event-type');
    if(eventTypeSelect) {
        eventTypeSelect.value = eventType;
        eventTypeSelect.dispatchEvent(new Event('change'));
    }

    const gymWorkoutContainer = document.getElementById('gym-workout-container');
    if(gymWorkoutContainer) gymWorkoutContainer.innerHTML = '';

    if (eventId) {
        const dayData = proData.schedule[dayKey];
        let eventData;
        if (eventType === 'class') eventData = dayData.classes.find(e => e.id === eventId);
        else if (eventType === 'otherTask') eventData = dayData.otherTasks.find(e => e.id === eventId);
        else if (eventType === 'gym') eventData = dayData.gym;

        if (eventData) {
            const [start, end] = (eventData.time || "00:00-00:00").split(/\s*-\s*/);
            const scheduleEventStartTimeInput = document.getElementById('schedule-event-start-time');
            if(scheduleEventStartTimeInput) scheduleEventStartTimeInput.value = start?.trim();

            const scheduleEventEndTimeInput = document.getElementById('schedule-event-end-time');
            if(scheduleEventEndTimeInput) scheduleEventEndTimeInput.value = end?.trim();
            
            const scheduleEventNameInput = document.getElementById('schedule-event-name');
            if(scheduleEventNameInput) scheduleEventNameInput.value = eventData.name || eventData.title;

            if (eventType === 'class') {
                const scheduleEventLocationInput = document.getElementById('schedule-event-location');
                if(scheduleEventLocationInput) scheduleEventLocationInput.value = eventData.location;
            }
            if (eventType === 'gym' && eventData.workout) {
                eventData.workout.forEach(ex => addExerciseField(ex.exercise, ex.setsReps));
            }
        }
    }

    openModal('schedule-event-modal');
}

function addExerciseField(exercise = '', setsReps = '') {
    const container = document.getElementById('gym-workout-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 exercise-field-group';
    div.innerHTML = `
        <input type="text" placeholder="Exercise" value="${escapeHtml(exercise)}" class="pro-input flex-grow gym-exercise-name">
        <input type="text" placeholder="Sets/Reps" value="${escapeHtml(setsReps)}" class="pro-input flex-grow gym-exercise-sets">
        <button type="button" class="danger-btn text-xs !py-1 !px-2 remove-exercise-btn">&times;</button>
    `;
    container.appendChild(div);
}

function handleScheduleEventFormSubmit(e) {
    e.preventDefault();
    const dayKey = document.getElementById('schedule-day-key').value;
    const eventId = document.getElementById('schedule-event-id').value;
    const originalType = document.getElementById('schedule-event-original-type').value;
    const eventType = document.getElementById('schedule-event-type').value;

    const time = `${document.getElementById('schedule-event-start-time').value} - ${document.getElementById('schedule-event-end-time').value}`;
    const name = document.getElementById('schedule-event-name').value;
    const newId = `${eventType}-${Date.now()}`;
    const scheduleDay = proData.schedule[dayKey];

    if (eventId) {
        if (originalType === 'class') scheduleDay.classes = scheduleDay.classes.filter(c => c.id !== eventId);
        else if (originalType === 'otherTask') scheduleDay.otherTasks = scheduleDay.otherTasks.filter(e => e.id !== eventId);
        else if (originalType === 'gym') scheduleDay.gym = { id: '', title: '', time: '', workout: [] };
    }

    if (eventType === 'class') {
        const newClass = { id: eventId || newId, name, time, location: document.getElementById('schedule-event-location').value };
        scheduleDay.classes.push(newClass);
    } else if (eventType === 'otherTask') {
        const newTask = { id: eventId || newId, name, time };
        scheduleDay.otherTasks.push(newTask);
    } else if (eventType === 'gym') {
        const workout = [];
        document.querySelectorAll('.exercise-field-group').forEach(group => {
            const exercise = group.querySelector('.gym-exercise-name').value;
            const setsReps = group.querySelector('.gym-exercise-sets').value;
            if (exercise) workout.push({ exercise, setsReps });
        });
        scheduleDay.gym = { id: eventId || newId, title: name, time, workout };
    }

    saveData();
    closeModal('schedule-event-modal');

    if (document.getElementById('day-view-modal')?.classList.contains('visible')) {
        document.getElementById('day-view-modal-body').innerHTML = renderDayView(dayKey);
    }
    if (document.getElementById('schedule-modal')?.classList.contains('visible')) {
        document.getElementById('schedule-modal-body').innerHTML = renderFullScheduleView();
    }
    const todayKey = new Date().toLocaleDateString('en-us', { weekday: 'long' }).toLowerCase();
    if (dayKey === todayKey) {
        refreshDashboardAgenda();
    }
}


function renderFullScheduleView() {
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const todayKey = new Date().toLocaleDateString('en-us', { weekday: 'long' }).toLowerCase();

    return weekdays.map(dayKey => {
        const dayData = proData.schedule[dayKey];
        if (!dayData) return '';

        const events = [
            ...(dayData.classes || []).map(c => ({ ...c, type: 'class' })),
            ...(dayData.otherTasks || []).map(t => ({ ...t, type: 'otherTask' })),
            ...(dayData.gym?.title ? ({ ...dayData.gym, name: dayData.gym.title, type: 'gym' }) : undefined)
        ].filter(Boolean).sort((a, b) => {
            const timeA = (a.time || "00:00").split(/\s*-\s*/)[0].trim();
            const timeB = (b.time || "00:00").split(/\s*-\s*/)[0].trim();
            // Sort by numerical time to handle '9:00' correctly before '10:00'
            return timeA.localeCompare(timeB, undefined, { numeric: true, sensitivity: 'base' });
        });

        const isTodayClass = dayKey === todayKey ? 'is-today' : '';

        let eventsHTML = `<p class="text-sm text-secondary pl-12">No events scheduled.</p>`;
        if (events.length > 0) {
            eventsHTML = events.map(event => `
                <div class="schedule-event">
                    <span class="schedule-event-time font-semibold">${escapeHtml((event.time || "00:00").split(/\s*-\s*/)[0].trim())}</span>
                    <div class="schedule-event-details">
                        <p class="schedule-event-name">${escapeHtml(event.name)}</p>
                        ${event.location ? `<p class="schedule-event-location">${escapeHtml(event.location)}</p>` : ''}
                    </div>
                </div>
            `).join('');
        }

        return `
            <div class="schedule-day-card is-clickable ${isTodayClass}" onclick="openDayViewModal('${dayKey}')">
                <div class="schedule-day-header">
                    <span>${escapeHtml(dayData.day)}</span>
                </div>
                ${eventsHTML}
            </div>
        `;
    }).join('');
}


function renderDayView(dayKey) {
    const dayData = proData.schedule[dayKey];
    if (!dayData) return '<p>No data for this day.</p>';

    const renderCategory = (title, items, type, renderItem) => {
        return `
            <div class="day-view-category">
                <div class="day-view-category-header">
                    <h4 class="day-view-category-title">${escapeHtml(title)}</h4>
                    <button onclick="openScheduleEventModal('${escapeHtml(dayKey)}', '${escapeHtml(type)}')" class="secondary-btn text-xs py-1 px-2">+ Add</button>
                </div>
                <div class="space-y-2">
                    ${items && items.length > 0 ? items.map(renderItem).join('') : '<p class="text-sm text-secondary">Nothing scheduled.</p>'}
                </div>
            </div>
        `;
    };

    const renderClass = (item) => `
        <div class="schedule-event group">
            <span class="schedule-event-time font-semibold">${escapeHtml(item.time)}</span>
            <div class="schedule-event-details">
                <p class="schedule-event-name">${escapeHtml(item.name)}</p>
                ${item.location ? `<p class="schedule-event-location">${escapeHtml(item.location)}</p>` : ''}
            </div>
            <div class="event-actions">
                <button onclick="openScheduleEventModal('${escapeHtml(dayKey)}', 'class', '${escapeHtml(item.id)}')" class="edit-event-btn">Edit</button>
                <button onclick="deleteScheduleEvent('${escapeHtml(dayKey)}', 'class', '${escapeHtml(item.id)}')" class="delete-event-btn">&times;</button>
            </div>
        </div>
    `;

    const renderOtherTask = (item) => `
        <div class="schedule-event group">
            <span class="schedule-event-time font-semibold">${escapeHtml(item.time)}</span>
            <div class="schedule-event-details"><p class="schedule-event-name">${escapeHtml(item.name)}</p></div>
             <div class="event-actions">
                <button onclick="openScheduleEventModal('${escapeHtml(dayKey)}', 'otherTask', '${escapeHtml(item.id)}')" class="edit-event-btn">Edit</button>
                <button onclick="deleteScheduleEvent('${escapeHtml(dayKey)}', 'otherTask', '${escapeHtml(item.id)}')" class="delete-event-btn">&times;</button>
            </div>
        </div>
    `;

    const gymHTML = () => {
        const gymData = dayData.gym;
        if (!gymData || !gymData.title) {
            return '<p class="text-sm text-secondary">No workout scheduled.</p>';
        }
        return `
            <div class="schedule-event group">
                <span class="schedule-event-time font-semibold">${escapeHtml(gymData.time)}</span>
                <div class="schedule-event-details">
                    <p class="schedule-event-name">${escapeHtml(gymData.title)}</p>
                </div>
                 <div class="event-actions">
                    <button onclick="openScheduleEventModal('${escapeHtml(dayKey)}', 'gym', '${escapeHtml(gymData.id)}')" class="edit-event-btn">Edit</button>
                    <button onclick="deleteScheduleEvent('${escapeHtml(dayKey)}', 'gym', '${escapeHtml(gymData.id)}')" class="delete-event-btn">&times;</button>
                </div>
            </div>
            ${(gymData.workout && gymData.workout.length > 0) ? `
            <div class="pl-12 mt-2 space-y-1">
                ${gymData.workout.map(w => `<div class="gym-exercise"><span>${escapeHtml(w.exercise)}</span><span>${escapeHtml(w.setsReps)}</span></div>`).join('')}
            </div>` : ''}
        `;
    };

    return `
        ${renderCategory('Classes', (dayData.classes || []).sort((a, b) => a.time.localeCompare(b.time)), 'class', renderClass)}
        <div class="day-view-category">
            <div class="day-view-category-header">
                <h4 class="day-view-category-title">Gym Session</h4>
                ${dayData.gym && dayData.gym.title ? '' : `<button onclick="openScheduleEventModal('${escapeHtml(dayKey)}', 'gym')" class="secondary-btn text-xs py-1 px-2">+ Add</button>`}
            </div>
            ${gymHTML()}
        </div>
        ${renderCategory('Other Tasks', (dayData.otherTasks || []).sort((a, b) => a.time.localeCompare(b.time)), 'otherTask', renderOtherTask)}
    `;
}

window.deleteScheduleEvent = (dayKey, eventType, eventId) => {
    const eventName = getEventNameById(dayKey, eventType, eventId);
    showConfirmation({
        title: 'Delete Event?',
        message: `Are you sure you want to delete "${escapeHtml(eventName)}"?`,
        confirmText: 'Delete'
    }, () => {
        if (eventType === 'class') {
            proData.schedule[dayKey].classes = proData.schedule[dayKey].classes.filter(c => c.id !== eventId);
        } else if (eventType === 'otherTask') {
            proData.schedule[dayKey].otherTasks = proData.schedule[dayKey].otherTasks.filter(t => t.id !== eventId);
        } else if (eventType === 'gym') {
            proData.schedule[dayKey].gym = { id: '', title: '', time: '', workout: [] };
        }
        saveData();
        if (document.getElementById('schedule-modal')?.classList.contains('visible')) {
            document.getElementById('schedule-modal-body').innerHTML = renderFullScheduleView();
        }
        if (document.getElementById('day-view-modal')?.classList.contains('visible')) {
            document.getElementById('day-view-modal-body').innerHTML = renderDayView(dayKey);
        }
        const todayKey = new Date().toLocaleDateString('en-us', { weekday: 'long' }).toLowerCase();
        if (dayKey === todayKey) {
            refreshDashboardAgenda();
        }
    });
}

function getEventNameById(dayKey, eventType, eventId) {
    const scheduleDay = proData.schedule[dayKey];
    if (!scheduleDay) return 'this event';

    if (eventType === 'class') {
        return (scheduleDay.classes || []).find(c => c.id === eventId)?.name || 'this event';
    } else if (eventType === 'otherTask') {
        return (scheduleDay.otherTasks || []).find(t => t.id === eventId)?.name || 'this event';
    } else if (eventType === 'gym') {
        return scheduleDay.gym?.title || 'this workout';
    }
    return 'this event';
}


window.exportSchedule = (format) => {
    switch (format) {
        case 'json': exportScheduleToJSON(); break;
        case 'csv': exportScheduleToCSV(); break;
        case 'ics': exportScheduleToICS(); break;
        case 'pdf': exportScheduleToPDF(); break;
        case 'word': exportScheduleToWord(); break;
    }
}

function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportScheduleToJSON() {
    downloadFile('pro_plus_schedule.json', JSON.stringify(proData.schedule, null, 2), 'application/json');
}

function exportScheduleToCSV() {
    let csvContent = "Day,Start Time,End Time,Subject,Location,Type\n";
    const schedule = proData.schedule;
    for (const day in schedule) {
        (schedule[day].classes || []).forEach(c => {
            const [start, end] = c.time.split(/\s*-\s*/);
            csvContent += `${day},${start || ''},${end || ''},"${c.name}","${c.location || ''}",Class\n`;
        });
        if ((schedule[day].gym?.title)) {
            const [start, end] = schedule[day].gym.time.split(/\s*-\s*/);
            csvContent += `${day},${start || ''},${end || ''},"${schedule[day].gym.title}","",Gym\n`;
        }
        (schedule[day].otherTasks || []).forEach(t => {
            const [start, end] = t.time.split(/\s*-\s*/);
            csvContent += `${day},${start || ''},${end || ''},"${t.name}","",Task\n`;
        });
    }
    downloadFile('pro_plus_schedule.csv', csvContent, 'text/csv');
}

function exportScheduleToICS() {
    let icsContent = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//PROPLUS//NONSGML v1.0//EN\n`;
    const dayMap = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
    const today = new Date();

    for (const day in proData.schedule) {
        const dayOfWeekNumber = dayMap[day];

        const processEvent = (event) => {
            const [start, end] = (event.time || "00:00-00:00").split(/\s*-\s*/);
            if (!start || !end) return;
            const [startHour, startMin] = start.trim().split(':');
            const [endHour, endMin] = end.trim().split(':');

            let eventDate = new Date();
            const currentDay = today.getDay();
            const distance = (dayOfWeekNumber - currentDay + 7) % 7;
            eventDate.setDate(today.getDate() + distance);

            const startDate = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate(), startHour, startMin);
            const endDate = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate(), endHour, endMin);

            const toUTC = (date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

            icsContent += 'BEGIN:VEVENT\n';
            icsContent += `DTSTAMP:${toUTC(new Date())}\n`;
            icsContent += `DTSTART:${toUTC(startDate)}\n`;
            icsContent += `DTEND:${toUTC(endDate)}\n`;
            icsContent += `RRULE:FREQ=WEEKLY;BYDAY=${day.substring(0, 2).toUpperCase()}\n`;
            icsContent += `SUMMARY:${event.name || event.title}\n`;
            if (event.location) icsContent += `LOCATION:${event.location}\n`;
            icsContent += `UID:${day}-${start.replace(':', '')}-${(event.name || event.title).replace(/\s/g, '')}@proplus.app\n`;
            icsContent += 'END:VEVENT\n';
        };

        (proData.schedule[day].classes || []).forEach(c => processEvent(c));
        (proData.schedule[day].otherTasks || []).forEach(t => processEvent(t));
        if (proData.schedule[day].gym?.title) processEvent(proData.schedule[day].gym);
    }

    icsContent += 'END:VCALENDAR';
    downloadFile('pro_plus_schedule.ics', icsContent, 'text/calendar');
}

function exportScheduleToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont('helvetica', 'bold');
    doc.text("PRO PLUS Weekly Schedule", 10, 10);
    doc.setFontSize(10);

    let y = 20;
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    days.forEach(day => {
        if (y > 280) {
            doc.addPage();
            y = 10;
        }
        const scheduleDay = proData.schedule[day];
        if (!scheduleDay) return;
        doc.setFont('helvetica', 'bold');
        doc.text(scheduleDay.day, 10, y);
        y += 7;
        doc.setFont('helvetica', 'normal');

        (scheduleDay.classes || []).forEach(c => {
            doc.text(`${c.time}: ${c.name} (${c.location})`, 15, y);
            y += 5;
        });
        if ((scheduleDay.gym?.title)) {
            doc.text(`${scheduleDay.gym.time}: ${scheduleDay.gym.title}`, 15, y);
            y += 5;
        }
        (scheduleDay.otherTasks || []).forEach(t => {
            doc.text(`${t.time}: ${t.name}`, 15, y);
            y += 5;
        });
        y += 5;
    });

    doc.save("pro_plus_schedule.pdf");
}

function exportScheduleToWord() {
    const { Document, Packer, Paragraph, TextRun, Table, TableCell, TableRow, WidthType } = window.docx;

    const rows = [];
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    days.forEach(day => {
        const scheduleDay = proData.schedule[day];
        if (!scheduleDay) return;

        let dayEvents = '';
        (scheduleDay.classes || []).forEach(c => {
            dayEvents += `${c.time}: ${c.name} (${c.location})\n`;
        });
        if (scheduleDay.gym?.title) {
            dayEvents += `${scheduleDay.gym.time}: ${scheduleDay.gym.title}\n`;
        }
        (scheduleDay.otherTasks || []).forEach(t => {
            dayEvents += `${t.time}: ${t.name}\n`;
        });

        rows.push(new TableRow({
            children: [
                new TableCell({ children: [new Paragraph(day.charAt(0).toUpperCase() + day.slice(1))] }),
                new TableCell({ children: dayEvents.split('\n').filter(e => e).map(e => new Paragraph(e)) }),
            ],
        }));
    });

    const table = new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE }
    });

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "PRO PLUS Weekly Schedule", bold: true, size: 32 })],
                }),
                table,
            ],
        }],
    });

    Packer.toBlob(doc).then(blob => {
        downloadFile('pro_plus_schedule.docx', blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });
}


// --- AI Chat (Gemini) ---
async function handleAssistantChat(e) {
    e.preventDefault();
    const form = document.getElementById('ai-chat-form');
    const input = document.getElementById('ai-chat-input');
    const body = document.getElementById('ai-chat-body');
    const userMessage = input.value.trim();
    if (!userMessage) return;

    if (!GEMINI_API_KEY) {
        // Create a new message bubble to inform the user
        const errorMessage = document.createElement('div');
        errorMessage.className = 'ai-message';
        errorMessage.textContent = "AI Assistant is not available. Please check the API key.";
        body.appendChild(errorMessage);
        input.value = '';
        if (body) body.scrollTop = body.scrollHeight;
        soundManager.playSound('error', 'C3');
        return;
    }

    const userMessageEl = document.createElement('div');
    userMessageEl.className = 'user-message';
    userMessageEl.textContent = userMessage; // Use textContent for security
    body.appendChild(userMessageEl);
    input.value = '';
    form?.querySelector('button')?.classList.add('is-loading');
    if (form) form.querySelector('button').disabled = true;
    if (body) body.scrollTop = body.scrollHeight;

    const thinkingMessage = document.createElement('div');
    thinkingMessage.className = 'ai-message opacity-50';
    thinkingMessage.textContent = 'Analyzing...';
    if (body) {
        body.appendChild(thinkingMessage);
        body.scrollTop = body.scrollHeight;
    }


    const systemPrompt = `You are PRO PLUS, an AI assistant integrated into a personal productivity dashboard.
    Your user's current data is provided below. Analyze it to answer questions and perform actions.
    When asked to perform an action (add, update, delete, complete), you MUST respond with a JSON object with "action" and "payload" keys.
    Example Actions:
    - {"action": "addTask", "payload": {"projectName": "Project Name", "taskText": "New Task Text"}}
    - {"action": "completeHabit", "payload": {"habitText": "Habit to complete"}}
    - {"action": "getSchedule", "payload": {"day": "monday"}}
    For general questions (e.g., 'what is my priority?'), respond with a concise, helpful, natural language text string. Do not use markdown.
    Keep your text responses under 50 words. Be direct and actionable.`;

    const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: `USER DATA: ${JSON.stringify(proData)}\n\nUSER PROMPT: "${userMessage}"` }] }],
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) throw new Error("No response from AI.");

        thinkingMessage.classList.remove('opacity-50');

        try {
            const parsed = JSON.parse(text);
            if (parsed.action) {
                const confirmation = executeAIAction(parsed.action, parsed.payload);
                thinkingMessage.textContent = confirmation;
            } else {
                thinkingMessage.textContent = text;
            }
        } catch (jsonError) {
            thinkingMessage.textContent = text;
        }

    } catch (error) {
        console.error("AI Assistant Error:", error);
        thinkingMessage.textContent = "Sorry, I encountered an error. Please try again.";
        thinkingMessage.style.backgroundColor = 'var(--danger-color)';
        soundManager.playSound('error', 'C3');
    } finally {
        form?.querySelector('button')?.classList.remove('is-loading');
        if (form) form.querySelector('button').disabled = false;
        if (body) body.scrollTop = body.scrollHeight;
    }
}

// [FIX 4] Improve AI response for getSchedule action
function executeAIAction(action, payload) {
    let confirmation = "Action completed.";
    try {
        switch (action.toLowerCase()) {
            case 'addtask': {
                if (!payload.projectName || !payload.taskText) throw new Error("Missing project name or task text.");
                const project = proData.projects.find(p => p.name.toLowerCase() === payload.projectName.toLowerCase());
                if (project) {
                    project.tasks.push({ id: `task-${Date.now()}`, text: payload.taskText, done: false, priority: 2 });
                    updateAndRefreshProjects();
                    confirmation = `Added task "${escapeHtml(payload.taskText)}" to project "${escapeHtml(project.name)}".`;
                } else throw new Error(`Project "${escapeHtml(payload.projectName)}" not found.`);
                break;
            }
            case 'completehabit': {
                if (!payload.habitText) throw new Error("Missing habit text.");
                const habit = proData.habits.find(h => h.text.toLowerCase().includes(payload.habitText.toLowerCase()));
                if (habit) {
                    if (!isHabitDoneToday(habit.id)) window.toggleHabit(habit.id);
                    confirmation = `Marked habit "${escapeHtml(habit.text)}" as complete. Keep up the great work!`;
                } else throw new Error(`Habit "${escapeHtml(payload.habitText)}" not found.`);
                break;
            }
            case 'getschedule': {
                if (!payload.day) throw new Error("Missing day for schedule lookup.");
                const day = payload.day.toLowerCase();
                const schedule = proData.schedule[day];
                if (schedule) {
                    const events = [
                        ...schedule.classes.map(c => `${c.time}: ${c.name}`),
                        ...(schedule.gym.title ? [`${schedule.gym.time}: ${schedule.gym.title}`] : []),
                        ...schedule.otherTasks.map(t => `${t.time}: ${t.name}`)
                    ].filter(Boolean);
                    confirmation = events.length > 0 ? `On ${escapeHtml(schedule.day)}, you have: ${events.map(e => escapeHtml(e)).join(', ')}.` : `You have no events scheduled for ${escapeHtml(schedule.day)}.`;
                } else throw new Error(`No schedule found for ${escapeHtml(payload.day)}.`);
                break;
            }
            default:
                throw new Error("Unknown action requested.");
        }
    } catch (e) {
        console.error("AI Action execution failed:", e);
        confirmation = `Failed to execute action: ${escapeHtml(e.message)}`;
        soundManager.playSound('error', 'C3');
    }
    return confirmation;
}

// --- FORM SUBMISSIONS ---
function handleProjectFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('project-id').value;
    const existingProject = id ? proData.projects.find(p => p.id === id) : null;
    const newProject = {
        id: id || `proj-${Date.now()}`,
        name: document.getElementById('project-name').value,
        description: document.getElementById('project-description').value,
        deadline: document.getElementById('project-deadline').value,
        status: existingProject?.status || 'active',
        tasks: existingProject?.tasks || []
    };
    if (id) {
        proData.projects = proData.projects.map(p => p.id === id ? newProject : p);
    } else {
        if (!proData.projects) proData.projects = [];
        proData.projects.push(newProject);
    }
    updateAndRefreshProjects();
    window.closeModal('project-modal');
}

// --- UTILITIES (TIMER/STOPWATCH) ---

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    const milliseconds = Math.floor((ms % 1000) / 10).toString().padStart(2, '0');
    return `${minutes}:${seconds}:${milliseconds}`;
}
// [FIX 1] Aligning function name with usages
function formatTimerDisplay(s) {
    const totalSeconds = Math.max(0, s);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

window.startStopwatch = () => {
    if (stopwatch.running) return;
    stopwatch.running = true;
    stopwatch.startTime = Date.now() - stopwatch.elapsed;
    stopwatch.interval = setInterval(updateStopwatch, 10);
};
window.pauseStopwatch = () => {
    if (!stopwatch.running) return;
    stopwatch.running = false;
    clearInterval(stopwatch.interval);
};
window.resetStopwatch = () => {
    stopwatch.running = false;
    clearInterval(stopwatch.interval);
    stopwatch.elapsed = 0;
    stopwatch.laps = [];
    document.getElementById('stopwatch-display').textContent = '00:00:00';
    document.getElementById('laps-list').innerHTML = '';
};
window.lapStopwatch = () => {
    if (!stopwatch.running) return;
    stopwatch.laps.push(stopwatch.elapsed);
    const lapsList = document.getElementById('laps-list');
    if (!lapsList) return;
    lapsList.innerHTML = '';
    stopwatch.laps.forEach((lap, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>Lap ${index + 1}</span><span>${formatTime(lap)}</span>`;
        lapsList.appendChild(li);
    });
    lapsList.scrollTop = lapsList.scrollHeight;
};
function updateStopwatch() {
    stopwatch.elapsed = Date.now() - stopwatch.startTime;
    document.getElementById('stopwatch-display').textContent = formatTime(stopwatch.elapsed);
}

window.startTimer = () => {
    const minutesInput = document.getElementById('timer-minutes');
    const secondsInput = document.getElementById('timer-seconds');
    const mins = parseInt(minutesInput?.value) || 0;
    const secs = parseInt(secondsInput?.value) || 0;
    const totalSeconds = (mins * 60) + secs;

    if (totalSeconds <= 0) return;

    if (timer.paused) {
        timer.endTime = Date.now() + timer.duration;
    } else {
        timer.duration = totalSeconds * 1000;
        timer.endTime = Date.now() + timer.duration;
    }
    timer.paused = false;
    if (timer.interval) clearInterval(timer.interval);
    timer.interval = setInterval(updateTimer, 100);
    document.getElementById('timer-inputs')?.classList.add('hidden');
    document.getElementById('timer-display')?.classList.remove('hidden');
};
window.pauseTimer = () => {
    if (!timer.endTime || timer.paused) return;
    clearInterval(timer.interval);
    timer.paused = true;
    timer.duration = timer.endTime - Date.now();
};
window.resetTimer = () => {
    clearInterval(timer.interval);
    timer.endTime = 0;
    timer.paused = false;
    timer.duration = 0;
    document.getElementById('timer-inputs')?.classList.remove('hidden');
    document.getElementById('timer-display')?.classList.add('hidden');
    const timerDisplay = document.getElementById('timer-display');
    if (timerDisplay) {
        timerDisplay.textContent = "00:00";
        timerDisplay.classList.remove('timer-done');
    }
    const minutesInput = document.getElementById('timer-minutes');
    if(minutesInput) minutesInput.value = '10';
    const secondsInput = document.getElementById('timer-seconds');
    if(secondsInput) secondsInput.value = '00';
};
function updateTimer() {
    const remaining = timer.endTime - Date.now();
    const timerDisplay = document.getElementById('timer-display');
    if (remaining <= 0) {
        clearInterval(timer.interval);
        if (timerDisplay) {
            timerDisplay.textContent = "00:00";
            timerDisplay.classList.add('timer-done');
        }
        soundManager.playSound('timerAlarm', 'C5', '2n');
        return;
    }
    if (timerDisplay) {
        timerDisplay.textContent = formatTimerDisplay(Math.ceil(remaining / 1000));
    }
}

window.switchUtilityView = (view) => {
    const timerView = document.getElementById('utility-timer-view');
    const stopwatchView = document.getElementById('utility-stopwatch-view');
    const timerBtn = document.getElementById('utility-timer-btn');
    const stopwatchBtn = document.getElementById('utility-stopwatch-btn');
    if (!timerView || !stopwatchView || !timerBtn || !stopwatchBtn) return;

    if (view === 'timer') {
        timerView.classList.remove('hidden');
        stopwatchView.classList.add('hidden');
        timerBtn.classList.replace('secondary-btn', 'pro-btn');
        stopwatchBtn.classList.replace('pro-btn', 'secondary-btn');
    } else {
        timerView.classList.add('hidden');
        stopwatchView.classList.remove('hidden');
        timerBtn.classList.replace('pro-btn', 'secondary-btn');
        stopwatchBtn.classList.replace('secondary-btn', 'pro-btn');
    }
}

function renderUtilitiesCard() {
    return `
        <div class="flex flex-col h-full">
            <div class="flex items-center justify-between mb-4">
                 <h3 class="text-xl font-semibold text-header tracking-tight">Time Tools</h3>
                 <div class="flex items-center border border-[--card-border] rounded-lg p-1">
                     <button id="utility-timer-btn" onclick="switchUtilityView('timer')" class="pro-btn text-xs !py-1 !px-3">Timer</button>
                     <button id="utility-stopwatch-btn" onclick="switchUtilityView('stopwatch')" class="secondary-btn text-xs !py-1 !px-3">Stopwatch</button>
                 </div>
            </div>

            <div id="utility-timer-view" class="flex-grow flex flex-col">
                <div class="flex flex-col items-center justify-center flex-grow">
                    <div id="timer-display" class="digital-display text-5xl mb-4 hidden">10:00</div>
                    <div id="timer-inputs" class="timer-inputs">
                        <input id="timer-minutes" type="number" min="0" max="99" value="10" class="pro-input">
                        <span>:</span>
                        <input type="number" id="timer-seconds" min="0" max="59" value="00" class="pro-input">
                    </div>
                    <div class="utility-controls w-full">
                        <button onclick="startTimer()" class="pro-btn text-sm !py-2">Start</button>
                        <button onclick="pauseTimer()" class="secondary-btn text-sm !py-2">Pause</button>
                        <button onclick="resetTimer()" class="danger-btn text-sm !py-2">Reset</button>
                        <button onclick="startTimerWithPreset(25)" class="secondary-btn text-sm !py-2 col-span-3 md:col-span-1">Pomodoro (25m)</button>
                    </div>
                </div>
            </div>

            <div id="utility-stopwatch-view" class="flex-grow flex flex-col hidden">
                 <div class="flex flex-col items-center justify-center flex-grow">
                     <div id="stopwatch-display" class="digital-display text-4xl mb-4">00:00:00</div>
                     <div class="utility-controls w-full">
                         <button onclick="startStopwatch()" class="pro-btn text-sm !py-2">Start</button>
                         <button onclick="pauseStopwatch()" class="secondary-btn text-sm !py-2">Pause</button>
                         <button onclick="lapStopwatch()" class="secondary-btn text-sm !py-2">Lap</button>
                         <button onclick="resetStopwatch()" class="danger-btn text-sm !py-2">Reset</button>
                     </div>
                     <div class="laps-container w-full mt-2">
                         <ul id="laps-list" class="laps-list"></ul>
                     </div>
                 </div>
            </div>
        </div>
    `;
}

window.startTimerWithPreset = (minutes) => {
    resetTimer();
    const minutesInput = document.getElementById('timer-minutes');
    const secondsInput = document.getElementById('timer-seconds');
    if (minutesInput) minutesInput.value = minutes;
    if (secondsInput) secondsInput.value = '00';
    startTimer();
}

// --- CSV IMPORT ---
window.importScheduleFromCSV = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const csv = e.target.result;
            const lines = csv.split('\n').filter(line => line.trim() !== '');
            const header = lines.shift()?.toLowerCase()?.split(',').map(h => h.trim().replace(/"/g, ''));

            if (!header || !['day', 'start time', 'end time', 'subject'].every(h => header.includes(h))) {
                throw new Error("Invalid CSV format. Required headers: Day, Start Time, End Time, Subject.");
            }

            let importCount = 0;
            lines.forEach(line => {
                const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
                const entry = header.reduce((obj, col, i) => {
                    obj[col] = values[i];
                    return obj;
                }, {});

                const dayKey = entry.day?.toLowerCase();
                if (proData.schedule[dayKey]) {
                    const eventType = entry.type?.toLowerCase() || 'class';
                    const newEvent = {
                        id: `${eventType}-${Date.now()}-${importCount}`,
                        name: entry.subject,
                        time: `${entry['start time']} - ${entry['end time']}`,
                        location: entry.location || ''
                    };

                    if (eventType === 'class') {
                        proData.schedule[dayKey].classes.push(newEvent);
                        importCount++;
                    } else if (eventType === 'othertask' || eventType === 'task') {
                        proData.schedule[dayKey].otherTasks.push(newEvent);
                        importCount++;
                    } else if (eventType === 'gym') {
                        proData.schedule[dayKey].gym = { id: newEvent.id, title: newEvent.name, time: newEvent.time, workout: [] };
                        importCount++;
                    }
                }
            });

            if (importCount > 0) {
                saveData();
                showConfirmation({ title: "Import Successful", message: `Successfully imported ${importCount} schedule events.`, buttons: `<button id="cancel-btn" class="pro-btn font-semibold py-2 px-6 rounded-lg">OK</button>` });
            } else {
                throw new Error("No valid events found in the CSV file.");
            }

        } catch (err) {
            console.error("CSV Import Error:", err);
            showConfirmation({ title: "Import Failed", message: err.message, buttons: `<button id="cancel-btn" class="secondary-btn font-semibold py-2 px-6 rounded-lg">OK</button>` });
            soundManager.playSound('error', 'C3');
        }
    };
    reader.readAsText(file);
    event.target.value = null;
};

// --- HABITS PAGE ---
function renderHabitsPage() {
    const main = document.getElementById('main-content');
    if (!main) return;
    main.innerHTML = `
        <header class="flex flex-wrap items-center justify-between mb-6 gap-4">
            <h1 class="text-3xl sm:text-4xl font-semibold text-header tracking-tight">Habit Tracker</h1>
            <button class="pro-btn" onclick="openModal('habit-modal')">Add New Habit</button>
        </header>
        <div id="habits-page-container" class="space-y-4"></div>
    `;
    renderHabitListForPage();
}

function renderHabitListForPage() {
    const container = document.getElementById('habits-page-container');
    if (!container) return;

    const habits = proData.habits || [];
    if (habits.length === 0) {
        container.innerHTML = `<div class="glass-card text-center p-8"><p class="text-secondary">No habits yet. Click 'Add New Habit' to get started!</p></div>`;
        return;
    }

    container.innerHTML = habits.sort((a, b) => b.priority - a.priority).map(habit => {
        const isDone = isHabitDoneToday(habit.id);
        const streak = habit.streak ?? 0;
        return `
        <div class="glass-card p-4 flex items-center justify-between">
            <div class="flex items-center">
                <label for="page-habit-${escapeHtml(habit.id)}" class="flex items-center cursor-pointer">
                    <input type="checkbox" id="page-habit-${escapeHtml(habit.id)}" ${isDone ? 'checked' : ''} onchange="toggleHabit('${escapeHtml(habit.id)}')" class="hidden">
                    <span class="checkbox-custom ${isDone ? 'checked' : ''}"></span>
                </label>
                <div class="ml-4">
                    <p class="text-base font-medium ${isDone ? 'line-through text-secondary' : ''}">${escapeHtml(habit.text)}</p>
                    <p class="text-xs text-secondary">Priority: ${escapeHtml(habit.priority.toString())}</p>
                </div>
            </div>
            <div class="flex items-center gap-4">
                <span class="text-sm font-semibold p-1 px-3 rounded-full bg-[--bg-primary]">🔥 ${escapeHtml(streak.toString())}</span>
                <div>
                     <button class="secondary-btn text-xs py-1 px-2" onclick="openModal('habit-modal', proData.habits.find(h => h.id === '${escapeHtml(habit.id)}'))">Edit</button>
                     <button class="danger-btn text-xs py-1 px-2 ml-2" onclick="showConfirmation({ title: 'Delete Habit?', message: 'Are you sure you want to delete this habit? This will also remove its history.', confirmText: 'Delete' }, () => deleteHabit('${escapeHtml(habit.id)}'))">Del</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}
// --- MISSING & FIXED FUNCTIONS ---

// Modal Controls
window.openModal = (modalId, data = null) => {
    soundManager.playSound('modalOpen', 'A3');
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const form = modal.querySelector('form');
    if(form) form.reset();

    if (data) {
        if (modalId === 'project-modal') {
            const projectIdInput = document.getElementById('project-id');
            const projectNameInput = document.getElementById('project-name');
            const projectDescriptionInput = document.getElementById('project-description');
            const projectDeadlineInput = document.getElementById('project-deadline');
            const projectModalTitle = document.getElementById('project-modal-title');
            
            if (projectIdInput) projectIdInput.value = data.id;
            if (projectNameInput) projectNameInput.value = data.name;
            if (projectDescriptionInput) projectDescriptionInput.value = data.description;
            if (projectDeadlineInput) projectDeadlineInput.value = data.deadline;
            if (projectModalTitle) projectModalTitle.textContent = 'Edit Project';
        } else if (modalId === 'task-modal') {
            const taskProjectIdInput = document.getElementById('task-project-id');
            if (taskProjectIdInput) taskProjectIdInput.value = data.projectId;
        } else if (modalId === 'habit-modal') {
            const habitIdInput = document.getElementById('habit-id');
            const habitTextInput = document.getElementById('habit-text');
            const habitPriorityInput = document.getElementById('habit-priority');
            const habitModalTitle = document.getElementById('habit-modal-title');

            if(habitIdInput) habitIdInput.value = data.id;
            if(habitTextInput) habitTextInput.value = data.text;
            if(habitPriorityInput) habitPriorityInput.value = data.priority;
            if(habitModalTitle) habitModalTitle.textContent = 'Edit Habit';
        }
    } else {
        if (modalId === 'project-modal') {
            const projectModalTitle = document.getElementById('project-modal-title');
            if (projectModalTitle) projectModalTitle.textContent = 'New Project';
        }
        if (modalId === 'habit-modal') {
            const habitModalTitle = document.getElementById('habit-modal-title');
            if (habitModalTitle) habitModalTitle.textContent = 'New Habit';
        }
    }

    modal.classList.add('visible');
}

window.closeModal = (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('visible');
}

// Project Actions
window.toggleProjectTask = (projectId, taskId) => {
    const project = proData.projects.find(p => p.id === projectId);
    if (project) {
        const task = project.tasks.find(t => t.id === taskId);
        if (task) {
            task.done = !task.done;
            soundManager.playSound('taskComplete', task.done ? 'G4' : 'G3');
            updateAndRefreshProjects();
        }
    }
};

window.deleteProject = (projectId) => {
    proData.projects = proData.projects.filter(p => p.id !== projectId);
    updateAndRefreshProjects();
};
window.archiveProject = (projectId) => {
    const project = proData.projects.find(p => p.id === projectId);
    if (project) {
        project.status = 'archived';
        updateAndRefreshProjects();
    }
};
window.unarchiveProject = (projectId) => {
    const project = proData.projects.find(p => p.id === projectId);
    if (project) {
        project.status = 'active';
        updateAndRefreshProjects();
    }
};

// Habit Actions
window.deleteHabit = (habitId) => {
    proData.habits = proData.habits.filter(h => h.id !== habitId);
    updateAndRefreshHabits();
}

// Form Handlers
function handleTaskFormSubmit(e) {
    e.preventDefault();
    const projectId = document.getElementById('task-project-id').value;
    const project = proData.projects.find(p => p.id === projectId);
    if (project) {
        const newTask = {
            id: `task-${Date.now()}`,
            text: document.getElementById('task-text').value,
            done: false,
            priority: parseInt(document.getElementById('task-priority').value) || 2,
        };
        project.tasks.push(newTask);
        updateAndRefreshProjects();
    }
    closeModal('task-modal');
}

function handleHabitFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('habit-id').value;
    const existingHabit = id ? proData.habits.find(h => h.id === id) : null;
    const newHabit = {
        id: id || `habit-${Date.now()}`,
        text: document.getElementById('habit-text').value,
        priority: parseInt(document.getElementById('habit-priority').value) || 3,
        streak: existingHabit ? existingHabit.streak : 0,
        history: existingHabit ? existingHabit.history : [],
    };
    if (id) {
        proData.habits = proData.habits.map(h => h.id === id ? newHabit : h);
    } else {
        if (!proData.habits) proData.habits = [];
        proData.habits.push(newHabit);
    }
    updateAndRefreshHabits();
    closeModal('habit-modal');
}

// User Name Change Handler
let nameChangeTimeout;
window.handleUserNameChange = (input) => {
    clearTimeout(nameChangeTimeout);
    nameChangeTimeout = setTimeout(() => {
        proData.settings.userName = input.value;
        saveData();
        const greetingEl = document.querySelector('#main-content h1');
        if (greetingEl && document.querySelector('.nav-btn[data-tab="dashboard"].active')) {
            greetingEl.textContent = getGreeting();
        }
    }, 500);
}

