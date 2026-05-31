(function() {
  // Global Supabase shortcut (resolved inside IIFE scope)
  const supabase = window.supabaseClient;

  // Global Caches
  let cachedShipments = [];
  let cachedCustomers = [];
  let cachedCountryPrices = [];
  let cachedInvoices = [];
  let cachedUsers = [];
  let cachedSettings = {};

  // Pagination Limits
  let shipmentsLimit = 50;
  let customersLimit = 50;

  // View Dirty States
  let viewDirtyState = {
    dashboard: true,
    shipments: true,
    customers: true,
    pricing: true,
    reports: true,
    settings: true
  };

  function markAllViewsDirty() {
    for (let view in viewDirtyState) {
      viewDirtyState[view] = true;
    }
  }

  // User Session States
  let currentUser = null;
  let currentUserRole = null; // 'Admin' or 'Employee'

  // Current Active View State
  let currentView = 'dashboard';

  // Global variables for edit states
  let currentEditingCustomer = null;
  let currentEditingShipment = null;

  // Realtime connection lock
  let isRealtimeListening = false;

  // App Initialized State
  let isAppInitialized = false;

  // Chart Instances
  let shipmentAnalyticsChartInstance = null;
  let countryDistributionChartInstance = null;

  // Helpers
  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      const context = this;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), wait);
    };
  }

  function showLoader() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  function hideLoader() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // Translation helpers
  let currentLang = localStorage.getItem('lang') || 'ar';

  function t(key) {
    if (window.translations && window.translations[currentLang] && window.translations[currentLang][key] !== undefined) {
      return window.translations[currentLang][key];
    }
    return key;
  }

  function getCountryName(c) {
    if (!c) return '';
    if (window.countryNames && window.countryNames[currentLang] && window.countryNames[currentLang][c.country_code]) {
      return window.countryNames[currentLang][c.country_code];
    }
    return c.country_name;
  }

  function changeLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('lang', lang);
    
    // Sync dropdown values
    const loginSelect = document.getElementById('login-lang-select');
    if (loginSelect) loginSelect.value = lang;
    
    const headerSelect = document.getElementById('header-lang-select');
    if (headerSelect) headerSelect.value = lang;

    // Apply attributes on document
    document.documentElement.lang = lang;
    document.documentElement.dir = (lang === 'ar' ? 'rtl' : 'ltr');

    translatePage();

    // Redraw view & charts
    markAllViewsDirty();
    refreshActiveViewDebounced();
    
    if (typeof renderDashboardCharts === 'function') {
      renderDashboardCharts();
    }
    
    // Repopulate selects if cached data is loaded
    if (cachedCountryPrices && cachedCountryPrices.length > 0) {
      populateShipmentModalCountries();
      populateShipmentsCountryFilter();
    }
  }

  function translatePage() {
    // Translate standard elements
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val !== undefined && val !== key) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.placeholder = val;
        } else {
          el.textContent = val;
        }
      }
    });
  }

  window.changeLanguage = changeLanguage;
  window.t = t;

  const STATUS_AR = {
    get received() { return t('status_received'); },
    get processing() { return t('status_processing'); },
    get transit() { return t('status_transit'); },
    get arrived() { return t('status_arrived'); },
    get delivered() { return t('status_delivered'); },
    get cancelled() { return t('status_cancelled'); }
  };

  function formatMAD(amount) {
    return `${Number(amount).toFixed(2)} DH`;
  }

  function generateTrackingNumber() {
    const chars = '0123456789';
    let random = '';
    for (let i = 0; i < 6; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `MA-EU-${random}`;
  }

  function generateCustomerID() {
    const chars = '0123456789';
    let random = '';
    for (let i = 0; i < 4; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CUST-${random}`;
  }

  // ==========================================================================
  // 1. APPLICATION INITIALIZATION & CORE AUTHENTICATION TRIGGERS
  // ==========================================================================

  // Global Toast System
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-triangle-exclamation';

    toast.innerHTML = `
      <i class="fa-solid ${icon}"></i>
      <span>${message}</span>
    `;
    
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 4500);
  }

  // Global Database query safely executed helper
  async function safeDbCall(promise, defaultValue = []) {
    try {
      const { data, error } = await promise;
      if (error) {
        console.warn("Supabase query warning:", error);
        return defaultValue;
      }
      return data || defaultValue;
    } catch (err) {
      console.error("Supabase engine call crash:", err);
      return defaultValue;
    }
  }

  // Auto Retry for failed background fetches
  async function fetchWithRetry(fn, retries = 3, delay = 1000) {
    try {
      return await fn();
    } catch (err) {
      if (retries <= 1) throw err;
      console.warn(`Database call failed, retrying in ${delay}ms... (Retries left: ${retries - 1})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(fn, retries - 1, delay * 1.5);
    }
  }

  // Setup Auth State Change Listener (Instant login, auto restore session)
  function setupAuthListener() {
    if (!supabase) {
      console.error("Supabase client is not connected.");
      return;
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      console.log(`[Supabase Auth] Event: ${event}`);
      const errorMsg = document.getElementById('login-error-msg');
      if (errorMsg) errorMsg.style.display = 'none';

      if (session && session.user) {
        currentUser = session.user;
        
        // Determine role from profile metadata or default to Employee
        currentUserRole = session.user.user_metadata?.role || 'Employee';
        
        const headerUsername = document.getElementById('header-username');
        const headerAvatar = document.getElementById('header-avatar');
        const name = session.user.user_metadata?.name || session.user.email.split('@')[0];
        
        if (headerUsername) headerUsername.textContent = name;
        if (headerAvatar) headerAvatar.textContent = name.charAt(0).toUpperCase();

        // Adjust controls and dashboard margins
        applyRolePermissions();

        // Show Main Application Shell instantly
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app-shell').style.display = 'flex';

        // Init routing state
        initApp();

        // Fetch database in background non-blocking
        loadAllDataBackground();
        setupRealtime();
      } else {
        currentUser = null;
        currentUserRole = null;
        document.getElementById('app-shell').style.display = 'none';
        document.getElementById('login-overlay').style.display = 'flex';
        
        // Destroy charts on logout
        if (shipmentAnalyticsChartInstance) {
          shipmentAnalyticsChartInstance.destroy();
          shipmentAnalyticsChartInstance = null;
        }
        if (countryDistributionChartInstance) {
          countryDistributionChartInstance.destroy();
          countryDistributionChartInstance = null;
        }
      }
    });
  }

  // Initialize Auth listener on script load
  setupAuthListener();

  async function handleLogin() {
    const emailInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error-msg');

    if (!supabase) {
      if (errorMsg) {
        errorMsg.textContent = "Supabase client غير متصل";
        errorMsg.style.display = 'block';
      }
      return;
    }

    showLoader();
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailInput,
        password: passwordInput
      });

      if (error) {
        if (errorMsg) {
          errorMsg.textContent = t('login_error_msg');
          errorMsg.style.display = 'block';
        }
        showToast(t('login_failed_toast'), "error");
      } else {
        showToast(t('login_success_toast'), "success");
      }
    } catch (err) {
      console.error("Login Error:", err);
    } finally {
      hideLoader();
    }
  }

  window.handleLogin = handleLogin;

  async function handleLogout() {
    if (supabase) {
      showLoader();
      try {
        await supabase.auth.signOut();
        showToast(t('logout_success_toast'), "success");
      } catch (e) {
        console.error(e);
      } finally {
        hideLoader();
      }
    }
  }

  window.handleLogout = handleLogout;

  function applyRolePermissions() {
    const isEmployee = currentUserRole === 'Employee';
    
    // Sidebar elements
    const pricingMenu = document.getElementById('menu-pricing');
    const settingsMenu = document.getElementById('menu-settings');
    const reportsMenu = document.getElementById('menu-reports');
    
    if (isEmployee) {
      if (pricingMenu) pricingMenu.style.display = 'none';
      if (settingsMenu) settingsMenu.style.display = 'none';
      if (reportsMenu) reportsMenu.style.display = 'none';
      
      // Hide monthly profits card on dashboard
      const monthlyProfitsCard = document.getElementById('kpi-monthly-profits')?.closest('.kpi-card');
      if (monthlyProfitsCard) monthlyProfitsCard.style.display = 'none';
      
      // Hide profit summary section on dashboard
      const profitTodayInput = document.getElementById('profit-today');
      if (profitTodayInput) {
        const profitsCard = profitTodayInput.closest('.card');
        if (profitsCard) profitsCard.style.display = 'none';
      }
    } else {
      if (pricingMenu) pricingMenu.style.display = 'block';
      if (settingsMenu) settingsMenu.style.display = 'block';
      if (reportsMenu) reportsMenu.style.display = 'block';
      
      const monthlyProfitsCard = document.getElementById('kpi-monthly-profits')?.closest('.kpi-card');
      if (monthlyProfitsCard) monthlyProfitsCard.style.display = 'flex';
      
      const profitTodayInput = document.getElementById('profit-today');
      if (profitTodayInput) {
        const profitsCard = profitTodayInput.closest('.card');
        if (profitsCard) profitsCard.style.display = 'flex';
      }
    }
  }

  // Background Loading Skeletons
  function renderAllSkeletons() {
    const recentTable = document.getElementById('dashboard-recent-table-body');
    if (recentTable) recentTable.innerHTML = getTableSkeletonHtml(8, 5);

    const countryBreakdown = document.getElementById('dashboard-country-breakdown');
    if (countryBreakdown) countryBreakdown.innerHTML = getCardSkeletonHtml(3);

    const shipmentsTable = document.getElementById('shipments-table-body');
    if (shipmentsTable) shipmentsTable.innerHTML = getTableSkeletonHtml(9, 8);

    const customersTable = document.getElementById('customers-table-body');
    if (customersTable) customersTable.innerHTML = getTableSkeletonHtml(9, 8);

    const kpis = ['kpi-total-shipments', 'kpi-transit-shipments', 'kpi-delivered-shipments', 'kpi-cancelled-shipments', 'kpi-monthly-profits'];
    kpis.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<span class="skeleton" style="width: 55px; height: 28px;"></span>`;
    });
  }

  function getTableSkeletonHtml(cols = 5, rows = 3) {
    let html = '';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        html += `<td><div class="skeleton skeleton-text" style="width: ${40 + Math.random() * 50}%"></div></td>`;
      }
      html += '</tr>';
    }
    return html;
  }

  function getCardSkeletonHtml(count = 3) {
    let html = '<div style="display:flex; flex-direction:column; gap:16px;">';
    for (let i = 0; i < count; i++) {
      html += `
        <div style="display:flex; flex-direction:column; gap:6px;">
          <div class="skeleton skeleton-text" style="width: 35%; height: 12px;"></div>
          <div class="skeleton skeleton-text" style="width: 100%; height: 8px;"></div>
        </div>
      `;
    }
    html += '</div>';
    return html;
  }

  // Fetch all database records into memory cache asynchronously (non-blocking)
  async function loadAllDataBackground() {
    if (!supabase) return;
    
    try {
      renderAllSkeletons();

      const pricesFetch = () => safeDbCall(supabase.from('country_prices').select('*'));
      const settingsFetch = () => safeDbCall(supabase.from('settings').select('*'));
      const customersFetch = () => safeDbCall(supabase.from('customers').select('*'));
      const shipmentsFetch = () => safeDbCall(supabase.from('shipments').select('*'));
      const invoicesFetch = () => safeDbCall(supabase.from('invoices').select('*'));

      const [pricesRes, settingsRes, customersRes, shipmentsRes, invoicesRes] = await Promise.all([
        fetchWithRetry(pricesFetch),
        fetchWithRetry(settingsFetch),
        fetchWithRetry(customersFetch),
        fetchWithRetry(shipmentsFetch),
        fetchWithRetry(invoicesFetch)
      ]);

      cachedCountryPrices = pricesRes || [];
      cachedCustomers = customersRes || [];
      cachedShipments = shipmentsRes || [];
      cachedInvoices = invoicesRes || [];

      cachedSettings = {};
      if (settingsRes) {
        settingsRes.forEach(s => {
          cachedSettings[s.key] = s.value;
        });
        if (cachedSettings['system_name']) {
          localStorage.setItem('atlas_system_name', cachedSettings['system_name']);
        }
      }

      if (currentUserRole === 'Admin') {
        const usersFetch = () => safeDbCall(supabase.from('users').select('*'));
        cachedUsers = await fetchWithRetry(usersFetch);
      }
      
      // Auto populate options
      populateShipmentModalCountries();
      populateShipmentsCountryFilter();

      markAllViewsDirty();
      refreshActiveView();
      renderDashboardCharts();

    } catch (err) {
      console.error("Error loading database tables:", err);
      showToast(t('connection_failed_db'), "error");
    }
  }

  // Subscribe to Supabase database changes in Realtime
  function setupRealtime() {
    if (isRealtimeListening || !supabase) return;
    isRealtimeListening = true;

    supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'country_prices' }, payload => {
        handleRealtimeEvent('country_prices', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, payload => {
        handleRealtimeEvent('customers', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, payload => {
        handleRealtimeEvent('shipments', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, payload => {
        handleRealtimeEvent('invoices', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, payload => {
        handleRealtimeEvent('users', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, payload => {
        handleRealtimeEvent('settings', payload);
      })
      .subscribe();
  }

  function handleRealtimeEvent(table, payload) {
    console.log(`Realtime update on ${table}:`, payload);
    const { eventType, new: newRecord, old: oldRecord } = payload;
    
    if (table === 'country_prices') {
      if (eventType === 'INSERT') {
        cachedCountryPrices.push(newRecord);
      } else if (eventType === 'UPDATE') {
        const idx = cachedCountryPrices.findIndex(c => c.country_code === newRecord.country_code);
        if (idx !== -1) cachedCountryPrices[idx] = newRecord;
      } else if (eventType === 'DELETE') {
        cachedCountryPrices = cachedCountryPrices.filter(c => c.country_code !== oldRecord.country_code);
      }
    }
    else if (table === 'customers') {
      if (eventType === 'INSERT') {
        cachedCustomers.push(newRecord);
      } else if (eventType === 'UPDATE') {
        const idx = cachedCustomers.findIndex(c => c.id === newRecord.id);
        if (idx !== -1) cachedCustomers[idx] = newRecord;
      } else if (eventType === 'DELETE') {
        cachedCustomers = cachedCustomers.filter(c => c.id !== oldRecord.id);
      }
    }
    else if (table === 'shipments') {
      if (eventType === 'INSERT') {
        cachedShipments.push(newRecord);
      } else if (eventType === 'UPDATE') {
        const idx = cachedShipments.findIndex(s => s.tracking_number === newRecord.tracking_number);
        if (idx !== -1) cachedShipments[idx] = newRecord;
      } else if (eventType === 'DELETE') {
        cachedShipments = cachedShipments.filter(s => s.tracking_number !== oldRecord.tracking_number);
      }
    }
    else if (table === 'invoices') {
      if (eventType === 'INSERT') {
        cachedInvoices.push(newRecord);
      } else if (eventType === 'UPDATE') {
        const idx = cachedInvoices.findIndex(i => i.invoice_number === newRecord.invoice_number);
        if (idx !== -1) cachedInvoices[idx] = newRecord;
      } else if (eventType === 'DELETE') {
        cachedInvoices = cachedInvoices.filter(i => i.invoice_number !== oldRecord.invoice_number);
      }
    }
    else if (table === 'users') {
      if (eventType === 'INSERT') {
        cachedUsers.push(newRecord);
      } else if (eventType === 'UPDATE') {
        const idx = cachedUsers.findIndex(u => u.id === newRecord.id);
        if (idx !== -1) cachedUsers[idx] = newRecord;
      } else if (eventType === 'DELETE') {
        cachedUsers = cachedUsers.filter(u => u.id !== oldRecord.id);
      }
    }
    else if (table === 'settings') {
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        cachedSettings[newRecord.key] = newRecord.value;
        if (newRecord.key === 'system_name') {
          localStorage.setItem('atlas_system_name', newRecord.value);
          loadSystemName();
        }
      } else if (eventType === 'DELETE') {
        delete cachedSettings[oldRecord.key];
      }
    }
    
    // Refresh layout
    markAllViewsDirty();
    refreshActiveViewDebounced();
  }

  function initApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;

    loadSystemName();
    switchView('dashboard');
    
    populateShipmentModalCountries();
    populateShipmentsCountryFilter();

    const today = new Date().toISOString().split('T')[0];
    const reportDateEl = document.getElementById('report-date-input');
    if (reportDateEl) reportDateEl.value = today;
    
    const reportMonthEl = document.getElementById('report-month-input');
    if (reportMonthEl) reportMonthEl.value = today.substring(0, 7);
  }

  // Collapsible Sidebar Mobile Handler
  function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    sidebar.classList.toggle('sidebar-open');

    let overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('sidebar-open');
        overlay.classList.remove('active');
      });
    }

    overlay.classList.toggle('active', sidebar.classList.contains('sidebar-open'));
  }

  window.toggleSidebar = toggleSidebar;

  function switchView(viewName) {
    const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
    menuItems.forEach(item => item.classList.remove('active'));
    
    const targetMenu = document.getElementById(`menu-${viewName}`);
    if (targetMenu) targetMenu.classList.add('active');

    const panels = document.querySelectorAll('.view-panel');
    panels.forEach(panel => panel.classList.remove('active'));
    
    const targetPanel = document.getElementById(`view-${viewName}`);
    if (targetPanel) targetPanel.classList.add('active');

    // Close mobile sidebar on select
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && sidebar.classList.contains('sidebar-open')) {
      sidebar.classList.remove('sidebar-open');
      const overlay = document.querySelector('.sidebar-overlay');
      if (overlay) overlay.classList.remove('active');
    }

    const prevView = currentView;
    currentView = viewName;

    const pageTitle = document.getElementById('page-view-title');
    const pageSubtitle = document.getElementById('page-view-subtitle');

    if (viewName === 'shipments') {
      shipmentsLimit = 50;
    } else if (viewName === 'customers') {
      customersLimit = 50;
    }

    const shouldRender = (prevView !== viewName) || viewDirtyState[viewName];

    switch (viewName) {
      case 'dashboard':
        if (pageTitle) pageTitle.textContent = t('page_title_dashboard');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_dashboard');
        if (shouldRender || viewDirtyState['dashboard']) {
          renderDashboard();
          renderDashboardCharts();
          viewDirtyState['dashboard'] = false;
        }
        break;
      case 'shipments':
        if (pageTitle) pageTitle.textContent = t('page_title_shipments');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_shipments');
        if (shouldRender || viewDirtyState['shipments']) {
          renderShipments();
          viewDirtyState['shipments'] = false;
        }
        break;
      case 'customers':
        if (pageTitle) pageTitle.textContent = t('page_title_customers');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_customers');
        if (shouldRender || viewDirtyState['customers']) {
          renderCustomers();
          viewDirtyState['customers'] = false;
        }
        break;
      case 'pricing':
        if (pageTitle) pageTitle.textContent = t('page_title_pricing');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_pricing');
        if (shouldRender || viewDirtyState['pricing']) {
          renderPricingSettings();
          viewDirtyState['pricing'] = false;
        }
        break;
      case 'reports':
        if (pageTitle) pageTitle.textContent = t('page_title_reports');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_reports');
        if (shouldRender || viewDirtyState['reports']) {
          generateReportData();
          viewDirtyState['reports'] = false;
        }
        break;
      case 'settings':
        if (pageTitle) pageTitle.textContent = t('page_title_settings');
        if (pageSubtitle) pageSubtitle.textContent = t('page_subtitle_settings');
        if (shouldRender || viewDirtyState['settings']) {
          renderUsersSettings();
          viewDirtyState['settings'] = false;
        }
        break;
    }
  }

  window.switchView = switchView;

  function refreshActiveView() {
    switch (currentView) {
      case 'dashboard':
        renderDashboard();
        renderDashboardCharts();
        viewDirtyState['dashboard'] = false;
        break;
      case 'shipments':
        renderShipments();
        viewDirtyState['shipments'] = false;
        break;
      case 'customers':
        renderCustomers();
        viewDirtyState['customers'] = false;
        break;
      case 'pricing':
        renderPricingSettings();
        viewDirtyState['pricing'] = false;
        break;
      case 'reports':
        generateReportData();
        viewDirtyState['reports'] = false;
        break;
      case 'settings':
        renderUsersSettings();
        viewDirtyState['settings'] = false;
        break;
    }
  }

  // Debounced view refresher that skips if user is typing
  const refreshActiveViewDebounced = debounce(() => {
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
    if (isTyping) {
      console.log("Skipping refreshActiveView: user is typing");
      return;
    }
    console.log("Executing refreshActiveView (debounced)");
    refreshActiveView();
  }, 500);


  // ==========================================================================
  // 2. DASHBOARD VIEW RENDER
  // ==========================================================================

  function renderDashboard() {
    const shipments = [...cachedShipments];
    
    const totalCount = shipments.length;
    const transitCount = shipments.filter(s => s.status === 'transit').length;
    const processingCount = shipments.filter(s => s.status === 'processing').length;
    const receivedCount = shipments.filter(s => s.status === 'received').length;
    const arrivedCount = shipments.filter(s => s.status === 'arrived').length;
    
    const pendingCount = processingCount + receivedCount + transitCount + arrivedCount;
    const deliveredCount = shipments.filter(s => s.status === 'delivered').length;
    const cancelledCount = shipments.filter(s => s.status === 'cancelled').length;

    // Earnings calculations
    const now = new Date();
    
    // Daily
    const todayStr = now.toISOString().split('T')[0];
    const todayShipments = shipments.filter(s => 
      s.created_at.startsWith(todayStr) && s.status !== 'cancelled'
    );
    const dailyRevenue = todayShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);

    // Weekly
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    
    const weeklyShipments = shipments.filter(s => {
      const sDate = new Date(s.created_at);
      return sDate >= startOfWeek && sDate < endOfWeek && s.status !== 'cancelled';
    });
    const weeklyRevenue = weeklyShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);

    // Monthly
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentMonthShipments = shipments.filter(s => 
      s.created_at.startsWith(currentYearMonth) && s.status !== 'cancelled'
    );
    const monthlyRevenue = currentMonthShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);

    // Yearly
    const currentYear = String(now.getFullYear());
    const currentYearShipments = shipments.filter(s => 
      s.created_at.startsWith(currentYear) && s.status !== 'cancelled'
    );
    const yearlyRevenue = currentYearShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);

    // Update DOM KPIs
    const elTotal = document.getElementById('kpi-total-shipments');
    const elTransit = document.getElementById('kpi-transit-shipments');
    const elDelivered = document.getElementById('kpi-delivered-shipments');
    const elCancelled = document.getElementById('kpi-cancelled-shipments');
    
    if (elTotal) elTotal.textContent = totalCount;
    if (elTransit) elTransit.textContent = pendingCount;
    if (elDelivered) elDelivered.textContent = deliveredCount;
    if (elCancelled) elCancelled.textContent = cancelledCount;
    
    const monthlyProfitsLabel = document.getElementById('kpi-monthly-profits');
    if (monthlyProfitsLabel) monthlyProfitsLabel.textContent = formatMAD(monthlyRevenue);

    const profitTodayLabel = document.getElementById('profit-today');
    if (profitTodayLabel) profitTodayLabel.textContent = formatMAD(dailyRevenue);

    const profitWeeklyLabel = document.getElementById('profit-weekly');
    if (profitWeeklyLabel) profitWeeklyLabel.textContent = formatMAD(weeklyRevenue);

    const profitMonthlyLabel = document.getElementById('profit-monthly');
    if (profitMonthlyLabel) profitMonthlyLabel.textContent = formatMAD(monthlyRevenue);

    const profitYearlyLabel = document.getElementById('profit-yearly');
    if (profitYearlyLabel) profitYearlyLabel.textContent = formatMAD(yearlyRevenue);

    // Recent 5 Shipments Table
    const recentTable = document.getElementById('dashboard-recent-table-body');
    if (recentTable) {
      recentTable.innerHTML = '';

      const sortedShipments = [...shipments]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5);

      if (sortedShipments.length === 0) {
        recentTable.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-secondary);">${t('empty_shipments')}</td></tr>`;
      } else {
        let recentHtml = '';
        sortedShipments.forEach(s => {
          const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
          const flag = countryObj ? countryObj.flag : '';
          const countryName = countryObj ? getCountryName(countryObj) : s.destination_country;

          recentHtml += `
            <tr>
              <td style="font-family:'Estedad', sans-serif; font-weight:700; color:var(--primary-color);">${s.tracking_number}</td>
              <td><strong>${s.sender_name}</strong></td>
              <td>${s.receiver_name}</td>
              <td>
                <div class="country-item">
                  <span class="country-flag">${flag}</span>
                  <span>${countryName}</span>
                </div>
              </td>
              <td>${s.weight} ${t('kg')} (${s.quantity} ${t('parcels')})</td>
              <td style="font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
              <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
              <td>
                <div class="actions-cell">
                  <button class="btn-icon" title="الفاتورة" onclick="openInvoiceModal('${s.tracking_number}')"><i class="fa-solid fa-file-invoice"></i></button>
                  <button class="btn-icon" title="تحديث الحالة" onclick="openStatusModal('${s.tracking_number}')"><i class="fa-solid fa-route"></i></button>
                </div>
              </td>
            </tr>
          `;
        });
        recentTable.innerHTML = recentHtml;
      }
    }

    // Country Breakdown Stats
    const countryBreakdown = document.getElementById('dashboard-country-breakdown');
    if (countryBreakdown) {
      countryBreakdown.innerHTML = '';

      const activeCountries = cachedCountryPrices.filter(c => c.is_active === true);
      const countryStats = [];
      
      activeCountries.forEach(c => {
        const count = shipments.filter(s => s.destination_country === c.country_code).length;
        if (count > 0) {
          countryStats.push({
            name: getCountryName(c),
            flag: c.flag,
            count: count
          });
        }
      });

      countryStats.sort((a, b) => b.count - a.count);

      if (countryStats.length === 0) {
        countryBreakdown.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12px;">${t('empty_country_stats')}</div>`;
      } else {
        let breakdownHtml = '';
        countryStats.slice(0, 5).forEach(stat => {
          const percentage = totalCount > 0 ? (stat.count / totalCount) * 100 : 0;
          breakdownHtml += `
            <div style="display:flex; flex-direction:column; gap:6px;">
              <div style="display:flex; justify-content:space-between; font-size:12px;">
                <span style="font-weight:700;">${stat.flag} ${stat.name}</span>
                <span style="color:var(--text-secondary); font-family:'Estedad', sans-serif; font-weight:700;">${stat.count} ${t('shipments_label')} (${percentage.toFixed(0)}%)</span>
              </div>
              <div style="width:100%; height:8px; background-color:var(--light-bg); border-radius:4px; overflow:hidden;">
                <div style="width:${percentage}%; height:100%; background-color:var(--primary-color); border-radius:4px;"></div>
              </div>
            </div>
          `;
        });
        countryBreakdown.innerHTML = breakdownHtml;
      }
    }
  }

  // Chart.js render analytics logic
  function renderDashboardCharts() {
    const shipments = [...cachedShipments];
    const countries = [...cachedCountryPrices];

    // 1. European Countries distribution doughnut chart
    const countryDistributionCanvas = document.getElementById('country-distribution-chart');
    if (countryDistributionCanvas) {
      const activeCountries = countries.filter(c => c.is_active === true);
      const countryLabels = [];
      const countryCounts = [];
      const countryColors = [];

      const baseColors = [
        'rgba(139, 0, 0, 0.75)',
        'rgba(0, 122, 255, 0.75)',
        'rgba(52, 199, 89, 0.75)',
        'rgba(255, 149, 0, 0.75)',
        'rgba(175, 82, 222, 0.75)',
        'rgba(255, 204, 0, 0.75)',
        'rgba(88, 86, 214, 0.75)',
        'rgba(90, 200, 250, 0.75)'
      ];

      activeCountries.forEach((c, idx) => {
        const count = shipments.filter(s => s.destination_country === c.country_code).length;
        if (count > 0) {
          countryLabels.push(`${c.flag} ${c.country_name}`);
          countryCounts.push(count);
          countryColors.push(baseColors[idx % baseColors.length]);
        }
      });

      if (countryDistributionChartInstance) {
        countryDistributionChartInstance.destroy();
        countryDistributionChartInstance = null;
      }

      if (countryCounts.length === 0) {
        countryDistributionCanvas.style.display = 'none';
        const parent = countryDistributionCanvas.parentElement;
        let noDataEl = parent.querySelector('.no-data-chart');
        if (!noDataEl) {
          noDataEl = document.createElement('div');
          noDataEl.className = 'no-data-chart';
          noDataEl.style.cssText = 'text-align:center; padding:50px 0; color:var(--text-secondary); font-size:12px;';
          noDataEl.innerHTML = `<i class="fa-solid fa-chart-pie" style="font-size:32px; margin-bottom:10px; opacity:0.5;"></i><br>${t('empty_chart_data')}`;
          parent.appendChild(noDataEl);
        }
      } else {
        countryDistributionCanvas.style.display = 'block';
        const noDataEl = countryDistributionCanvas.parentElement.querySelector('.no-data-chart');
        if (noDataEl) noDataEl.remove();

        const ctx = countryDistributionCanvas.getContext('2d');
        countryDistributionChartInstance = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: countryLabels,
            datasets: [{
              data: countryCounts,
              backgroundColor: countryColors,
              borderWidth: 1,
              borderColor: '#ffffff'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'right',
                rtl: true,
                labels: {
                  font: {
                    family: 'Estedad, system-ui'
                  }
                }
              }
            }
          }
        });
      }
    }

    // 2. Shipment Analytics last 7 days metrics
    const shipmentAnalyticsCanvas = document.getElementById('shipment-analytics-chart');
    if (shipmentAnalyticsCanvas) {
      const labels = [];
      const shipmentCounts = [];
      const profitAmounts = [];

      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];

        const labelFormatted = d.toLocaleDateString('ar-MA', { day: 'numeric', month: 'short' });
        labels.push(labelFormatted);

        const dayShipments = shipments.filter(s => s.created_at.startsWith(dateStr) && s.status !== 'cancelled');
        shipmentCounts.push(dayShipments.length);

        const dayRevenue = dayShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);
        profitAmounts.push(dayRevenue);
      }

      if (shipmentAnalyticsChartInstance) {
        shipmentAnalyticsChartInstance.destroy();
        shipmentAnalyticsChartInstance = null;
      }

      const ctx = shipmentAnalyticsCanvas.getContext('2d');
      shipmentAnalyticsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'عدد الشحنات',
              data: shipmentCounts,
              backgroundColor: 'rgba(0, 122, 255, 0.75)',
              yAxisID: 'y'
            },
            {
              label: 'المداخيل (DH)',
              data: profitAmounts,
              type: 'line',
              borderColor: 'rgba(139, 0, 0, 0.95)',
              borderWidth: 2,
              backgroundColor: 'rgba(139, 0, 0, 0.1)',
              fill: true,
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              type: 'linear',
              display: true,
              position: 'right',
              grid: {
                drawOnChartArea: false
              },
              title: {
                display: true,
                text: 'عدد الشحنات',
                font: { family: 'Estedad, system-ui' }
              }
            },
            y1: {
              type: 'linear',
              display: true,
              position: 'left',
              title: {
                display: true,
                text: 'المداخيل بالدرهم (DH)',
                font: { family: 'Estedad, system-ui' }
              }
            },
            x: {
              grid: {
                color: '#f0f0f0'
              },
              ticks: {
                font: { family: 'Estedad, system-ui' }
              }
            }
          },
          plugins: {
            legend: {
              rtl: true,
              labels: {
                font: { family: 'Estedad, system-ui' }
              }
            }
          }
        }
      });
    }
  }

  // ==========================================================================
  // 3. SHIPMENTS LOGIC & RENDERING
  // ==========================================================================

  function populateShipmentModalCountries() {
    const select = document.getElementById('shipment-country');
    if (!select) return;
    const countries = [...cachedCountryPrices].sort((a, b) => a.country_name.localeCompare(b.country_name, 'ar'));
    
    let html = '<option value="">-- اختر دولة الوجهة --</option>';
    countries.forEach(c => {
      html += `<option value="${c.country_code}">${c.flag} ${c.country_name}</option>`;
    });
    select.innerHTML = html;
  }

  function populateShipmentsCountryFilter() {
    const select = document.getElementById('shipment-country-filter');
    if (!select) return;
    const countries = [...cachedCountryPrices].sort((a, b) => a.country_name.localeCompare(b.country_name, 'ar'));
    
    let html = '<option value="">كل دول أوروبا</option>';
    countries.forEach(c => {
      html += `<option value="${c.country_code}">${c.flag} ${c.country_name}</option>`;
    });
    select.innerHTML = html;
  }

  function renderShipments() {
    filterShipments();
  }

  function filterShipments(resetPagination = true) {
    if (resetPagination) {
      shipmentsLimit = 50;
    }
    const searchInput = document.getElementById('shipment-search');
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    
    const countryFilterEl = document.getElementById('shipment-country-filter');
    const countryFilter = countryFilterEl ? countryFilterEl.value : '';
    
    const statusFilterEl = document.getElementById('shipment-status-filter');
    const statusFilter = statusFilterEl ? statusFilterEl.value : '';
    
    let shipments = [...cachedShipments];

    // Filters
    if (countryFilter) {
      shipments = shipments.filter(s => s.destination_country === countryFilter);
    }
    if (statusFilter) {
      shipments = shipments.filter(s => s.status === statusFilter);
    }
    if (searchQuery) {
      shipments = shipments.filter(s => 
        s.tracking_number.toLowerCase().includes(searchQuery) ||
        s.sender_name.toLowerCase().includes(searchQuery) ||
        s.receiver_name.toLowerCase().includes(searchQuery) ||
        s.city.toLowerCase().includes(searchQuery)
      );
    }

    // Sort: Newest first
    shipments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const tableBody = document.getElementById('shipments-table-body');
    if (tableBody) {
      tableBody.innerHTML = '';

      const totalFilteredCount = shipments.length;
      const displayedShipments = shipments.slice(0, shipmentsLimit);

      if (displayedShipments.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-secondary);">${t('empty_shipments_search')}</td></tr>`;
        const pagContainer = document.getElementById('shipments-pagination');
        if (pagContainer) pagContainer.style.display = 'none';
        return;
      }

      let tableHtml = '';
      displayedShipments.forEach(s => {
        const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
        const flag = countryObj ? countryObj.flag : '';
        const countryName = countryObj ? getCountryName(countryObj) : s.destination_country;

        // Permission check for modifying shipment: admin can edit all, employee only their own
        const isOwnShipment = currentUser && s.employee_id === currentUser.id;
        const canEdit = currentUserRole === 'Admin' || isOwnShipment;
        const canDelete = currentUserRole === 'Admin';

        const editBtn = canEdit 
          ? `<button class="btn-icon" title="${currentLang === 'ar' ? 'تعديل' : 'Modifier'}" onclick="openEditShipmentModal('${s.tracking_number}')"><i class="fa-solid fa-pen-to-square"></i></button>`
          : `<button class="btn-icon" disabled style="opacity:0.3; cursor:not-allowed;" title="${currentLang === 'ar' ? 'لا يمكنك تعديل شحنات غيرك' : 'Vous ne pouvez pas modifier les envois des autres'}"><i class="fa-solid fa-pen-to-square"></i></button>`;
          
        const deleteBtn = canDelete
          ? `<button class="btn-icon delete" title="${currentLang === 'ar' ? 'حذف الشحنة' : 'Supprimer l\'envoi'}" onclick="deleteShipmentData('${s.tracking_number}')"><i class="fa-solid fa-trash-can"></i></button>`
          : '';

        tableHtml += `
          <tr>
            <td style="font-family:'Estedad', sans-serif; font-weight:900; color:var(--primary-color);">${s.tracking_number}</td>
            <td style="font-size:11px; color:var(--text-secondary);">${s.created_at.split('T')[0]}</td>
            <td>
              <div style="font-weight:700;">${s.sender_name}</div>
              <div style="font-size:11px; color:var(--text-secondary);">${s.sender_phone}</div>
            </td>
            <td>
              <div style="font-weight:700;">${s.receiver_name}</div>
              <div style="font-size:11px; color:var(--text-secondary);">${s.receiver_phone}</div>
            </td>
            <td>
              <div class="country-item" style="font-weight:700;">
                <span class="country-flag">${flag}</span>
                <span>${countryName} - ${s.city}</span>
              </div>
              <div style="font-size:11px; color:var(--text-secondary); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.full_address}</div>
            </td>
            <td>
              <div style="font-weight:700;">${s.weight} ${t('kg')}</div>
              <div style="font-size:11px; color:var(--text-secondary);">${s.quantity} ${t('parcels')}</div>
            </td>
            <td style="font-family:'Estedad', sans-serif; font-weight:800; font-size:14px; color:var(--text-dark);">${formatMAD(s.shipping_price)}</td>
            <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
            <td>
              <div class="actions-cell">
                <button class="btn-icon" title="${currentLang === 'ar' ? 'الفاتورة' : 'Facture'}" onclick="openInvoiceModal('${s.tracking_number}')"><i class="fa-solid fa-file-invoice"></i></button>
                <button class="btn-icon" title="${currentLang === 'ar' ? 'تحديث الحالة' : 'Mettre à jour le statut'}" onclick="openStatusModal('${s.tracking_number}')"><i class="fa-solid fa-route"></i></button>
                ${editBtn}
                ${deleteBtn}
              </div>
            </td>
          </tr>
        `;
      });
      tableBody.innerHTML = tableHtml;

      // Pagination UI
      const paginationContainer = document.getElementById('shipments-pagination');
      if (paginationContainer) {
        if (totalFilteredCount > shipmentsLimit) {
          paginationContainer.style.display = 'flex';
          paginationContainer.innerHTML = `
            <span class="pagination-info">${t('pagination_showing') || (currentLang === 'ar' ? 'يعرض' : 'Affichage de')} ${displayedShipments.length} ${t('pagination_of') || (currentLang === 'ar' ? 'من أصل' : 'sur')} ${totalFilteredCount} ${t('shipments_label')}</span>
            <button class="btn-load-more" onclick="loadMoreShipments()">
              <i class="fa-solid fa-spinner"></i> ${t('btn_load_more') || (currentLang === 'ar' ? 'تحميل المزيد' : 'Charger plus')}
            </button>
          `;
        } else {
          paginationContainer.style.display = 'none';
        }
      }
    }
  }

  window.filterShipments = filterShipments;

  function loadMoreShipments() {
    shipmentsLimit += 50;
    filterShipments(false);
  }

  window.loadMoreShipments = loadMoreShipments;

  function openNewShipmentModal() {
    currentEditingShipment = null;
    const titleEl = document.getElementById('shipment-modal-title');
    if (titleEl) titleEl.textContent = t('modal_title_new_shipment');
    
    const newCode = generateTrackingNumber();
    const displayEl = document.getElementById('shipment-tracking-display');
    if (displayEl) displayEl.textContent = newCode;
    
    populateCustomersDropdown('shipment-sender-select');

    const form = document.getElementById('shipment-form');
    if (form) form.reset();
    
    const editId = document.getElementById('shipment-edit-id');
    if (editId) editId.value = '';
    
    const priceInput = document.getElementById('shipment-price');
    if (priceInput) priceInput.value = '';
    
    const priceHint = document.getElementById('price-calc-hint');
    if (priceHint) priceHint.textContent = t('price_calc_hint_initial');
    
    const modal = document.getElementById('shipment-modal');
    if (modal) modal.showModal();
  }

  window.openNewShipmentModal = openNewShipmentModal;

  function openEditShipmentModal(trackingNumber) {
    const shipment = cachedShipments.find(s => s.tracking_number === trackingNumber);
    if (!shipment) return;

    currentEditingShipment = shipment;
    const titleEl = document.getElementById('shipment-modal-title');
    if (titleEl) titleEl.textContent = t('modal_title_edit_shipment');
    
    const trackingDisplay = document.getElementById('shipment-tracking-display');
    if (trackingDisplay) trackingDisplay.textContent = shipment.tracking_number;

    populateCustomersDropdown('shipment-sender-select', shipment.sender_customer_id);

    const editId = document.getElementById('shipment-edit-id');
    if (editId) editId.value = shipment.tracking_number;
    
    const senderName = document.getElementById('shipment-sender-name');
    if (senderName) senderName.value = shipment.sender_name;
    
    const senderPhone = document.getElementById('shipment-sender-phone');
    if (senderPhone) senderPhone.value = shipment.sender_phone;
    
    const receiverName = document.getElementById('shipment-receiver-name');
    if (receiverName) receiverName.value = shipment.receiver_name;
    
    const receiverPhone = document.getElementById('shipment-receiver-phone');
    if (receiverPhone) receiverPhone.value = shipment.receiver_phone;

    const destCountry = document.getElementById('shipment-country');
    if (destCountry) destCountry.value = shipment.destination_country;
    
    const city = document.getElementById('shipment-city');
    if (city) city.value = shipment.city;
    
    const address = document.getElementById('shipment-address');
    if (address) address.value = shipment.full_address;
    
    const quantity = document.getElementById('shipment-quantity');
    if (quantity) quantity.value = shipment.quantity;
    
    const weight = document.getElementById('shipment-weight');
    if (weight) weight.value = shipment.weight;
    
    const price = document.getElementById('shipment-price');
    if (price) price.value = shipment.shipping_price;
    
    const status = document.getElementById('shipment-status');
    if (status) status.value = shipment.status;
    
    const notes = document.getElementById('shipment-notes');
    if (notes) notes.value = shipment.notes || '';

    const calcHint = document.getElementById('price-calc-hint');
    if (calcHint) calcHint.textContent = t('price_calc_hint_edit');
    
    const modal = document.getElementById('shipment-modal');
    if (modal) modal.showModal();
  }

  window.openEditShipmentModal = openEditShipmentModal;

  function populateCustomersDropdown(selectId, selectedValue = '') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const customers = [...cachedCustomers].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    
    let html = '<option value="">-- اختر عميلاً مرسلاً --</option>';
    customers.forEach(c => {
      const selected = c.id === selectedValue ? 'selected' : '';
      html += `<option value="${c.id}" ${selected}>${c.name} (${c.phone})</option>`;
    });
    select.innerHTML = html;
  }

  function autoFillSenderInfo() {
    const select = document.getElementById('shipment-sender-select');
    const customerId = select ? select.value : '';
    
    const nameInput = document.getElementById('shipment-sender-name');
    const phoneInput = document.getElementById('shipment-sender-phone');

    if (customerId) {
      const cust = cachedCustomers.find(c => c.id === customerId);
      if (cust) {
        if (nameInput) nameInput.value = cust.name;
        if (phoneInput) phoneInput.value = cust.phone;
      }
    } else {
      if (nameInput) nameInput.value = '';
      if (phoneInput) phoneInput.value = '';
    }
  }

  window.autoFillSenderInfo = autoFillSenderInfo;

  function calculateShippingPrice() {
    const countryCode = document.getElementById('shipment-country').value;
    const weightVal = parseFloat(document.getElementById('shipment-weight').value) || 0;
    const quantityVal = parseInt(document.getElementById('shipment-quantity').value) || 1;
    const priceInput = document.getElementById('shipment-price');
    const calcHint = document.getElementById('price-calc-hint');

    if (!countryCode || weightVal <= 0) {
      return;
    }

    const rate = cachedCountryPrices.find(c => c.country_code === countryCode);
    if (!rate) return;

    // Shipping calculation logic: Base Price + (Weight * Price per Kg) + 15 DH for extra packages
    let finalPrice = Number(rate.base_price) + (weightVal * Number(rate.price_per_kg));
    if (quantityVal > 1) {
      finalPrice += (quantityVal - 1) * 15;
    }

    finalPrice = Math.round(finalPrice);
    if (priceInput) priceInput.value = finalPrice;
    if (calcHint) calcHint.textContent = `السعر التلقائي: الأساسي (${rate.base_price} DH) + الوزن (${rate.price_per_kg} DH/كجم) + الطرود الإضافية.`;
  }

  window.calculateShippingPrice = calculateShippingPrice;

  async function saveShipmentData() {
    if (!supabase) return;
    const editId = document.getElementById('shipment-edit-id').value;
    const senderId = document.getElementById('shipment-sender-select').value;
    const senderName = document.getElementById('shipment-sender-name').value;
    const senderPhone = document.getElementById('shipment-sender-phone').value;
    
    const receiverName = document.getElementById('shipment-receiver-name').value.trim();
    const receiverPhone = document.getElementById('shipment-receiver-phone').value.trim();
    const destinationCountry = document.getElementById('shipment-country').value;
    const city = document.getElementById('shipment-city').value.trim();
    const fullAddress = document.getElementById('shipment-address').value.trim();
    const quantity = parseInt(document.getElementById('shipment-quantity').value) || 1;
    const weight = parseFloat(document.getElementById('shipment-weight').value) || 1;
    const shippingPrice = parseFloat(document.getElementById('shipment-price').value) || 0;
    const status = document.getElementById('shipment-status').value;
    const notes = document.getElementById('shipment-notes').value.trim();

    showLoader();

    if (editId) {
      // Update shipment on Supabase
      const s = cachedShipments.find(ship => ship.tracking_number === editId);
      if (!s) {
        hideLoader();
        return;
      }
      
      let history = [...s.status_history];
      if (s.status !== status) {
        history.push({
          status: status,
          date: new Date().toISOString(),
          note: currentLang === 'ar' ? 'تم تعديل تفاصيل الحالة' : 'Détails du statut modifiés'
        });
      }

      const { error } = await supabase
        .from('shipments')
        .update({
          receiver_name: receiverName,
          receiver_phone: receiverPhone,
          destination_country: destinationCountry,
          city: city,
          full_address: fullAddress,
          quantity: quantity,
          weight: weight,
          shipping_price: shippingPrice,
          status: status,
          notes: notes || null,
          status_history: history
        })
        .eq('tracking_number', editId);
        
      hideLoader();
      if (error) {
        showToast((currentLang === 'ar' ? "خطأ أثناء حفظ تعديلات الشحنة: " : "Erreur lors de la modification de l'envoi : ") + error.message, "error");
      } else {
        showToast(t('toast_shipment_updated'), "success");
        const modal = document.getElementById('shipment-modal');
        if (modal) modal.close();
      }
    } else {
      // Insert new shipment on Supabase
      const trackingNumber = document.getElementById('shipment-tracking-display').textContent;
      const history = [{
        status: status,
        date: new Date().toISOString(),
        note: currentLang === 'ar' ? 'تسجيل الشحنة بالمستودع' : 'Enregistrement du colis au dépôt'
      }];
      
      const newShipment = {
        tracking_number: trackingNumber,
        sender_name: senderName,
        sender_phone: senderPhone,
        sender_customer_id: senderId,
        receiver_name: receiverName,
        receiver_phone: receiverPhone,
        destination_country: destinationCountry,
        city: city,
        full_address: fullAddress,
        weight: weight,
        quantity: quantity,
        shipping_price: shippingPrice,
        status: status,
        notes: notes || null,
        status_history: history,
        employee_id: currentUser ? currentUser.id : null
      };

      const { error } = await supabase
        .from('shipments')
        .insert(newShipment);
        
      if (error) {
        hideLoader();
        showToast((currentLang === 'ar' ? "خطأ أثناء تسجيل الشحنة الجديدة: " : "Erreur lors de l'enregistrement du colis : ") + error.message, "error");
        return;
      }

      // Auto create matching invoice
      const invoiceNum = `FAC-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${trackingNumber.slice(-4)}`;
      const newInvoice = {
        invoice_number: invoiceNum,
        shipment_tracking_number: trackingNumber,
        customer_id: senderId,
        customer_name: senderName,
        total_amount: shippingPrice,
        payment_status: 'paid',
        payment_method: 'cash'
      };
      
      await safeDbCall(supabase.from('invoices').insert(newInvoice));
      
      hideLoader();
      showToast(t('toast_shipment_added'), "success");
      const modal = document.getElementById('shipment-modal');
      if (modal) modal.close();
    }
  }

  window.saveShipmentData = saveShipmentData;

  async function deleteShipmentData(trackingNumber) {
    if (!supabase) return;
    const confirmMsg = currentLang === 'ar' 
      ? `هل أنت متأكد من حذف الشحنة رقم ${trackingNumber} نهائياً من قاعدة البيانات؟` 
      : `Voulez-vous vraiment supprimer définitivement l'envoi N° ${trackingNumber} de la base de données ?`;
    if (confirm(confirmMsg)) {
      showLoader();
      const { error } = await supabase
        .from('shipments')
        .delete()
        .eq('tracking_number', trackingNumber);
        
      hideLoader();
      if (error) {
        showToast((currentLang === 'ar' ? "خطأ أثناء حذف الشحنة: " : "Erreur lors de la suppression de l'envoi : ") + error.message, "error");
      } else {
        showToast(t('toast_shipment_deleted'), "success");
      }
    }
  }

  window.deleteShipmentData = deleteShipmentData;

  // ==========================================================================
  // 4. STATUS CHANGE OVERLAYS
  // ==========================================================================

  function openStatusModal(trackingNumber) {
    const s = cachedShipments.find(ship => ship.tracking_number === trackingNumber);
    if (!s) return;

    const trackingInput = document.getElementById('status-update-tracking');
    if (trackingInput) trackingInput.value = trackingNumber;

    const select = document.getElementById('status-update-select');
    if (select) select.value = s.status;

    const note = document.getElementById('status-update-note');
    if (note) note.value = '';

    const modal = document.getElementById('status-modal');
    if (modal) modal.showModal();
  }

  window.openStatusModal = openStatusModal;

  async function saveStatusUpdate() {
    if (!supabase) return;
    const trackingNumber = document.getElementById('status-update-tracking').value;
    const newStatus = document.getElementById('status-update-select').value;
    const noteText = document.getElementById('status-update-note').value.trim() || (currentLang === 'ar' ? 'تحديث روتيني لحالة الشحن' : 'Mise à jour de routine du statut');

    const s = cachedShipments.find(ship => ship.tracking_number === trackingNumber);
    if (!s) return;

    showLoader();
    const history = [...s.status_history, {
      status: newStatus,
      date: new Date().toISOString(),
      note: noteText
    }];

    const { error } = await supabase
      .from('shipments')
      .update({
        status: newStatus,
        status_history: history
      })
      .eq('tracking_number', trackingNumber);

    hideLoader();
    if (error) {
      showToast((currentLang === 'ar' ? "خطأ أثناء تحديث حالة الشحنة: " : "Erreur lors de la mise à jour du statut : ") + error.message, "error");
    } else {
      showToast(t('toast_status_updated'), "success");
      const modal = document.getElementById('status-modal');
      if (modal) modal.close();
    }
  }

  window.saveStatusUpdate = saveStatusUpdate;

  // ==========================================================================
  // 5. CUSTOMERS MANAGEMENT
  // ==========================================================================

  function renderCustomers() {
    filterCustomers();
  }

  function filterCustomers() {
    const searchInput = document.getElementById('customer-search');
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    let customers = [...cachedCustomers];

    if (searchQuery) {
      customers = customers.filter(c => 
        c.name.toLowerCase().includes(searchQuery) ||
        c.phone.includes(searchQuery) ||
        c.morocco_id.toLowerCase().includes(searchQuery)
      );
    } else {
      customers.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    }

    const tableBody = document.getElementById('customers-table-body');
    if (tableBody) {
      tableBody.innerHTML = '';

      if (customers.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-secondary);">${t('empty_customers_search')}</td></tr>`;
        return;
      }

      customers.forEach(c => {
        const deleteBtn = currentUserRole === 'Admin'
          ? `<button class="btn-icon delete" title="${currentLang === 'ar' ? 'حذف العميل' : 'Supprimer le client'}" onclick="deleteCustomerData('${c.id}')"><i class="fa-solid fa-user-xmark"></i></button>`
          : '';

        tableBody.innerHTML += `
          <tr>
            <td style="font-family:'Estedad', sans-serif; font-weight:700;">${c.id}</td>
            <td><strong>${c.name}</strong></td>
            <td style="direction:ltr; text-align:right;">${c.phone}</td>
            <td>${c.email || '<span style="color:var(--text-secondary);">--</span>'}</td>
            <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.address || '<span style="color:var(--text-secondary);">--</span>'}</td>
            <td style="font-family:'Estedad', sans-serif; font-weight:700;">${c.morocco_id}</td>
            <td style="font-size:11px; color:var(--text-secondary);">${c.created_at.split('T')[0]}</td>
            <td style="font-family:'Estedad', sans-serif; font-weight:700;">${c.shipments_count} ${t('shipments_label') || (currentLang === 'ar' ? 'شحنات' : 'envois')}</td>
            <td>
              <div class="actions-cell">
                <button class="btn-icon" title="${t('modal_title_history')}" onclick="openCustomerHistory('${c.id}')"><i class="fa-solid fa-list-check"></i></button>
                <button class="btn-icon" title="${currentLang === 'ar' ? 'تعديل' : 'Modifier'}" onclick="openEditCustomerModal('${c.id}')"><i class="fa-solid fa-pen-to-square"></i></button>
                ${deleteBtn}
              </div>
            </td>
          </tr>
        `;
      });
    }
  }

  window.filterCustomers = filterCustomers;

  function openNewCustomerModal() {
    currentEditingCustomer = null;
    const title = document.getElementById('customer-modal-title');
    if (title) title.textContent = t('modal_title_new_customer');
    
    const form = document.getElementById('customer-form');
    if (form) form.reset();
    
    const editId = document.getElementById('customer-edit-id');
    if (editId) editId.value = '';
    
    const modal = document.getElementById('customer-modal');
    if (modal) modal.showModal();
  }

  window.openNewCustomerModal = openNewCustomerModal;

  function openEditCustomerModal(customerId) {
    const cust = cachedCustomers.find(c => c.id === customerId);
    if (!cust) return;

    currentEditingCustomer = cust;
    const title = document.getElementById('customer-modal-title');
    if (title) title.textContent = t('modal_title_edit_customer');
    
    const editId = document.getElementById('customer-edit-id');
    if (editId) editId.value = cust.id;
    
    const name = document.getElementById('customer-name');
    if (name) name.value = cust.name;
    
    const phone = document.getElementById('customer-phone');
    if (phone) phone.value = cust.phone;
    
    const email = document.getElementById('customer-email');
    if (email) email.value = cust.email || '';
    
    const moroccoId = document.getElementById('customer-morocco-id');
    if (moroccoId) moroccoId.value = cust.morocco_id;
    
    const address = document.getElementById('customer-address');
    if (address) address.value = cust.address || '';

    const modal = document.getElementById('customer-modal');
    if (modal) modal.showModal();
  }

  window.openEditCustomerModal = openEditCustomerModal;

  async function saveCustomerData() {
    if (!supabase) return;
    const editId = document.getElementById('customer-edit-id').value;
    const name = document.getElementById('customer-name').value.trim();
    const phone = document.getElementById('customer-phone').value.trim();
    const email = document.getElementById('customer-email').value.trim();
    const moroccoId = document.getElementById('customer-morocco-id').value.trim().toUpperCase();
    const address = document.getElementById('customer-address').value.trim();

    showLoader();
    const customerData = {
      name,
      phone,
      email: email || null,
      morocco_id: moroccoId,
      address: address || null
    };

    if (editId) {
      const { error } = await supabase
        .from('customers')
        .update(customerData)
        .eq('id', editId);
        
      hideLoader();
      if (error) {
        showToast(t('error_update_customer') + error.message, "error");
      } else {
        showToast(t('toast_customer_updated'), "success");
        const modal = document.getElementById('customer-modal');
        if (modal) modal.close();
      }
    } else {
      const newId = generateCustomerID();
      const { error } = await supabase
        .from('customers')
        .insert({
          id: newId,
          ...customerData,
          shipments_count: 0
        });
        
      hideLoader();
      if (error) {
        showToast("خطأ أثناء إضافة العميل الجديد: " + error.message, "error");
      } else {
        showToast("تم تسجيل العميل بنجاح في النظام", "success");
        const modal = document.getElementById('customer-modal');
        if (modal) modal.close();
      }
    }
  }

  window.saveCustomerData = saveCustomerData;

  async function deleteCustomerData(customerId) {
    if (!supabase) return;
    const cust = cachedCustomers.find(c => c.id === customerId);
    if (!cust) return;

    if (cust.shipments_count > 0) {
      const countMsg = t('toast_customer_has_shipments').replace('{count}', cust.shipments_count);
      showToast(countMsg, "error");
      return;
    }

    const confirmMsg = currentLang === 'ar'
      ? `هل أنت متأكد من حذف العميل "${cust.name}" نهائياً؟`
      : `Voulez-vous vraiment supprimer définitivement le client "${cust.name}" ?`;
    if (confirm(confirmMsg)) {
      showLoader();
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', customerId);
        
      hideLoader();
      if (error) {
        showToast((currentLang === 'ar' ? "خطأ أثناء حذف العميل: " : "Erreur lors de la suppression du client : ") + error.message, "error");
      } else {
        showToast(t('toast_customer_deleted'), "success");
      }
    }
  }

  window.deleteCustomerData = deleteCustomerData;

  function openCustomerHistory(customerId) {
    const cust = cachedCustomers.find(c => c.id === customerId);
    if (!cust) return;

    const title = document.getElementById('history-modal-title');
    if (title) title.textContent = `${t('modal_title_history')} : ${cust.name}`;

    const shipments = cachedShipments
      .filter(s => s.sender_customer_id === customerId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const tableBody = document.getElementById('history-table-body');
    if (tableBody) {
      tableBody.innerHTML = '';

      if (shipments.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-secondary);">${t('empty_history')}</td></tr>`;
      } else {
        shipments.forEach(s => {
          const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
          const flag = countryObj ? countryObj.flag : '';
          const countryName = countryObj ? getCountryName(countryObj) : s.destination_country;

          tableBody.innerHTML += `
            <tr>
              <td style="font-family:'Estedad', sans-serif; font-weight:700; color:var(--primary-color);">${s.tracking_number}</td>
              <td style="font-size:11px;">${s.created_at.split('T')[0]}</td>
              <td><strong>${s.receiver_name}</strong></td>
              <td>${flag} ${countryName}</td>
              <td>${s.weight} ${t('kg')}</td>
              <td style="font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
              <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
            </tr>
          `;
        });
      }
    }

    const modal = document.getElementById('history-modal');
    if (modal) modal.showModal();
  }

  window.openCustomerHistory = openCustomerHistory;

  // ==========================================================================
  // 6. PRICING SETTINGS LOGIC
  // ==========================================================================

  function renderPricingSettings() {
    filterPricingList();
  }

  function filterPricingList() {
    const searchInput = document.getElementById('pricing-search');
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    let countries = [...cachedCountryPrices];

    if (searchQuery) {
      countries = countries.filter(c => 
        c.country_name.toLowerCase().includes(searchQuery) ||
        c.country_code.toLowerCase().includes(searchQuery)
      );
    } else {
      countries.sort((a, b) => a.country_name.localeCompare(b.country_name, 'ar'));
    }

    const container = document.getElementById('country-pricing-list-container');
    if (container) {
      container.innerHTML = '';

      if (countries.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-secondary);">${t('empty_pricing_search')}</div>`;
        return;
      }

      const isAdmin = currentUserRole === 'Admin';
      const disabledAttr = isAdmin ? '' : 'disabled';
      const saveBtn = isAdmin 
        ? (cCode) => `<button class="btn-primary" style="padding: 8px 16px; font-size:11px;" onclick="saveCountryPriceRate('${cCode}')"><i class="fa-solid fa-floppy-disk"></i> ${t('btn_save') || (currentLang === 'ar' ? 'حفظ' : 'Enregistrer')}</button>`
        : () => '';

      countries.forEach(c => {
        container.innerHTML += `
          <div class="pricing-row" id="pricing-row-${c.country_code}">
            <div class="country-details">
              <span style="font-size:24px;">${c.flag}</span>
              <div>
                <div style="font-weight:800; font-size:14px;">${c.country_name}</div>
                <span style="font-size:10px; font-family:'Estedad', sans-serif; background-color:#eaeaea; padding:2px 6px; border-radius:4px;">${c.country_code}</span>
              </div>
            </div>
            
            <div class="pricing-inputs">
              <div class="mini-input-group">
                <label>التعرفة الأساسية (DH)</label>
                <input type="number" id="base-price-${c.country_code}" class="mini-input" value="${c.base_price}" ${disabledAttr}>
              </div>
              
              <div class="mini-input-group">
                <label>سعر الكيلو الإضافي (DH)</label>
                <input type="number" id="per-kg-${c.country_code}" class="mini-input" value="${c.price_per_kg}" ${disabledAttr}>
              </div>
              
              ${saveBtn(c.country_code)}
            </div>
          </div>
        `;
      });
    }
  }

  window.filterPricingList = filterPricingList;

  async function saveCountryPriceRate(countryCode) {
    if (!supabase) return;
    const basePriceVal = parseFloat(document.getElementById(`base-price-${countryCode}`).value) || 0;
    const perKgVal = parseFloat(document.getElementById(`per-kg-${countryCode}`).value) || 0;

    showLoader();
    const { error } = await supabase
      .from('country_prices')
      .update({
        base_price: basePriceVal,
        price_per_kg: perKgVal
      })
      .eq('country_code', countryCode);

    hideLoader();
    if (error) {
      showToast((currentLang === 'ar' ? "خطأ أثناء حفظ تعديل السعر: " : "Erreur lors de la modification des tarifs : ") + error.message, "error");
    } else {
      showToast(t('toast_pricing_updated'), "success");
      const row = document.getElementById(`pricing-row-${countryCode}`);
      if (row) {
        row.style.borderColor = 'var(--color-success)';
        row.style.backgroundColor = '#e8f5e9';
        
        setTimeout(() => {
          row.style.borderColor = 'var(--border-light)';
          row.style.backgroundColor = 'var(--light-bg)';
        }, 1500);
      }
    }
  }

  window.saveCountryPriceRate = saveCountryPriceRate;

  // ==========================================================================
  // 7. INVOICE RENDERING & PDF PRINT PREVIEW
  // ==========================================================================

  function openInvoiceModal(trackingNumber) {
    const s = cachedShipments.find(ship => ship.tracking_number === trackingNumber);
    if (!s) return;

    const invoice = cachedInvoices.find(i => i.shipment_tracking_number === trackingNumber);
    const invoiceNum = invoice ? invoice.invoice_number : `FAC-TEMP-${trackingNumber.slice(-4)}`;

    const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
    const flag = countryObj ? countryObj.flag : '';
    const countryName = countryObj ? getCountryName(countryObj) : s.destination_country;

    const invoicePrintArea = document.getElementById('invoice-print-area');
    
    if (invoicePrintArea) {
      invoicePrintArea.innerHTML = `
        <div class="invoice-header">
          <div class="invoice-logo-section">
            <div class="invoice-logo">
              <i class="fa-solid fa-paper-plane"></i>
            </div>
            <div>
              <h1 class="invoice-company-name">${t('invoice_company_name')}</h1>
              <p class="invoice-company-sub">${t('invoice_company_sub')}</p>
            </div>
          </div>
          <div class="invoice-meta">
            <h2 class="invoice-title-text">${t('invoice_title_text')}</h2>
            <div class="invoice-number">${t('invoice_number_label')} <span style="font-family:'Estedad', sans-serif;">${invoiceNum}</span></div>
            <div class="invoice-date">${t('invoice_date_label')} ${s.created_at.split('T')[0]}</div>
          </div>
        </div>

        <div class="invoice-parties">
          <div class="party-box">
            <div class="party-title">${t('invoice_sender_title')}</div>
            <div class="party-name">${s.sender_name}</div>
            <div class="party-details">
              <span>${t('invoice_sender_phone')} ${s.sender_phone}</span>
              <span>${t('invoice_sender_id')} ${s.notes || '--'}</span>
            </div>
          </div>

          <div class="party-box">
            <div class="party-title">${t('invoice_receiver_title')}</div>
            <div class="party-name">${s.receiver_name}</div>
            <div class="party-details">
              <span>${t('invoice_receiver_country')} ${flag} ${countryName}</span>
              <span>${t('invoice_receiver_city')} ${s.city}</span>
              <span>${t('invoice_receiver_phone')} ${s.receiver_phone}</span>
              <span>${t('invoice_receiver_address')} ${s.full_address}</span>
            </div>
          </div>
        </div>

        <table class="invoice-table">
          <thead>
            <tr>
              <th>${t('invoice_details_header')}</th>
              <th style="text-align:center;">${t('invoice_table_poids')}</th>
              <th style="text-align:center;">${t('invoice_table_colis')}</th>
              <th style="text-align:left;">${t('invoice_table_subtotal')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>${t('invoice_service_desc')}</strong><br>
                <span style="font-size:11px; color:#555;">${t('invoice_service_sub').replace('{country}', countryName).replace('{tracking}', s.tracking_number)}</span>
              </td>
              <td style="text-align:center; font-family:'Estedad', sans-serif;">${s.weight} ${t('kg')}</td>
              <td style="text-align:center; font-family:'Estedad', sans-serif;">${s.quantity}</td>
              <td style="text-align:left; font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
            </tr>
          </tbody>
        </table>

        <div class="invoice-totals">
          <div class="total-row">
            <span>${t('invoice_taxable')}</span>
            <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price * 0.8)}</span>
          </div>
          <div class="total-row">
            <span>${t('invoice_vat')}</span>
            <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price * 0.2)}</span>
          </div>
          <div class="total-row grand-total">
            <span>${t('invoice_grand_total')}</span>
            <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price)}</span>
          </div>
        </div>

        <div style="background-color:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; padding:12px; margin-bottom:30px; text-align:center; font-weight:700; color:#2e7d32; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="fa-solid fa-circle-check"></i> ${t('invoice_paid_full')}
        </div>

        <div class="invoice-footer">
          <p>${t('invoice_footer_thanks')}</p>
          <p style="margin-top:6px; font-size:10px; color:#a1a1a6;">Atlas Cargo System - Supabase Realtime Engine</p>
        </div>
      `;
    }

    const modal = document.getElementById('invoice-modal');
    if (modal) modal.showModal();
  }

  window.openInvoiceModal = openInvoiceModal;

  // ==========================================================================
  // 8. FINANCIAL REPORTS & EXCEL EXPORTS
  // ==========================================================================

  function updateReportDateInputs() {
    const type = document.getElementById('report-type').value;
    
    document.getElementById('report-date-container').style.display = type === 'daily' ? 'block' : 'none';
    document.getElementById('report-month-container').style.display = type === 'monthly' ? 'block' : 'none';
    document.getElementById('report-year-container').style.display = type === 'yearly' ? 'block' : 'none';

    generateReportData();
  }

  window.updateReportDateInputs = updateReportDateInputs;

  function generateReportData() {
    const typeEl = document.getElementById('report-type');
    if (!typeEl) return;
    const type = typeEl.value;
    const shipments = [...cachedShipments];
    let filtered = [];

    if (type === 'daily') {
      const dateVal = document.getElementById('report-date-input').value;
      if (!dateVal) return;
      filtered = shipments.filter(s => s.created_at.startsWith(dateVal));
    } else if (type === 'monthly') {
      const monthVal = document.getElementById('report-month-input').value;
      if (!monthVal) return;
      filtered = shipments.filter(s => s.created_at.startsWith(monthVal));
    } else if (type === 'yearly') {
      const yearVal = document.getElementById('report-year-input').value;
      filtered = shipments.filter(s => s.created_at.startsWith(yearVal));
    }

    const activeShipments = filtered.filter(s => s.status !== 'cancelled');
    
    const totalCount = filtered.length;
    const totalWeight = activeShipments.reduce((sum, s) => sum + Number(s.weight), 0);
    const grossBilling = activeShipments.reduce((sum, s) => sum + Number(s.shipping_price), 0);
    const estimatedProfit = grossBilling * 0.35; // 35% margin

    const summaryGrid = document.getElementById('report-summary-cards');
    if (summaryGrid) {
      summaryGrid.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-info">
            <span class="kpi-title">${t('report_kpi_total')}</span>
            <span class="kpi-value">${totalCount} ${t('shipments_label') || (currentLang === 'ar' ? 'شحنات' : 'envois')}</span>
          </div>
          <div class="kpi-icon kpi-all"><i class="fa-solid fa-boxes-stacked"></i></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-info">
            <span class="kpi-title">${currentLang === 'ar' ? 'الوزن الإجمالي المشحون' : 'Poids total expédié'}</span>
            <span class="kpi-value">${totalWeight.toFixed(1)} ${t('kg')}</span>
          </div>
          <div class="kpi-icon kpi-transit"><i class="fa-solid fa-weight-scale"></i></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-info">
            <span class="kpi-title">${t('report_kpi_revenue')}</span>
            <span class="kpi-value">${formatMAD(grossBilling)}</span>
          </div>
          <div class="kpi-icon kpi-delivered"><i class="fa-solid fa-chart-line"></i></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-info">
            <span class="kpi-title">${currentLang === 'ar' ? 'صافي الأرباح المقدرة (35%)' : 'Bénéfice net estimé (35%)'}</span>
            <span class="kpi-value" style="color:var(--color-success);">${formatMAD(estimatedProfit)}</span>
          </div>
          <div class="kpi-icon kpi-revenue"><i class="fa-solid fa-hand-holding-dollar"></i></div>
        </div>
      `;
    }

    const tableBody = document.getElementById('report-table-body');
    if (tableBody) {
      tableBody.innerHTML = '';

      if (filtered.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-secondary);">${t('empty_report_data')}</td></tr>`;
        return;
      }

      filtered.forEach(s => {
        const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
        const flag = countryObj ? countryObj.flag : '';
        const countryName = countryObj ? getCountryName(countryObj) : s.destination_country;

        tableBody.innerHTML += `
          <tr>
            <td style="font-family:'Estedad', sans-serif; font-weight:700;">${s.tracking_number}</td>
            <td>${s.created_at.split('T')[0]}</td>
            <td><strong>${s.sender_name}</strong></td>
            <td>${s.receiver_name}</td>
            <td>${flag} ${countryName} - ${s.city}</td>
            <td style="font-family:'Estedad', sans-serif;">${s.weight} ${t('kg')}</td>
            <td style="font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
            <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
          </tr>
        `;
      });
    }
  }

  window.generateReportData = generateReportData;

  function printReport() {
    window.print();
  }

  window.printReport = printReport;

  function exportReportToCSV() {
    const type = document.getElementById('report-type').value;
    let title = `تقرير_نشاط_وكالة_أطلس_${type}`;

    const rows = [
      ['رقم التتبع', 'تاريخ الشحن', 'اسم المرسل', 'رقم المرسل', 'اسم المستلم', 'بلد الوجهة', 'المدينة', 'الوزن (كجم)', 'سعر الشحن (درهم)', 'حالة الشحنة']
    ];

    const shipments = [...cachedShipments];
    let filtered = [];

    if (type === 'daily') {
      const dateVal = document.getElementById('report-date-input').value;
      filtered = shipments.filter(s => s.created_at.startsWith(dateVal));
      title += `_${dateVal}`;
    } else if (type === 'monthly') {
      const monthVal = document.getElementById('report-month-input').value;
      filtered = shipments.filter(s => s.created_at.startsWith(monthVal));
      title += `_${monthVal}`;
    } else if (type === 'yearly') {
      const yearVal = document.getElementById('report-year-input').value;
      filtered = shipments.filter(s => s.created_at.startsWith(yearVal));
      title += `_${yearVal}`;
    }

    if (filtered.length === 0) {
      showToast('لا توجد بيانات لتصديرها بالتقرير المختار', "error");
      return;
    }

    filtered.forEach(s => {
      const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
      const countryName = countryObj ? countryObj.country_name : s.destination_country;

      rows.push([
        s.tracking_number,
        s.created_at.split('T')[0],
        s.sender_name,
        s.sender_phone,
        s.receiver_name,
        countryName,
        s.city,
        s.weight,
        s.shipping_price,
        STATUS_AR[s.status]
      ]);
    });

    // Arabic UTF-8 CSV handling
    let csvContent = '\uFEFF';
    rows.forEach(rowArray => {
      const row = rowArray.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      csvContent += row + '\r\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${title}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("تم تصدير ملف التقرير بنجاح", "success");
  }

  window.exportReportToCSV = exportReportToCSV;

  // ==========================================================================
  // 9. BACKUP & RESTORE DATABASE
  // ==========================================================================

  function triggerDatabaseBackup() {
    try {
      const backupObj = {
        version: '2.0.0-supabase',
        timestamp: new Date().toISOString(),
        data: {
          customers: cachedCustomers,
          shipments: cachedShipments,
          invoices: cachedInvoices,
          country_prices: cachedCountryPrices,
          settings: cachedSettings
        }
      };
      
      const jsonStr = JSON.stringify(backupObj, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      
      const dateStr = new Date().toISOString().slice(0, 10);
      link.setAttribute('href', url);
      link.setAttribute('download', `atlas_supabase_backup_${dateStr}.json`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast(t('toast_backup_exported'), "success");
    } catch (e) {
      showToast(t('toast_backup_failed') + e.message, "error");
    }
  }

  window.triggerDatabaseBackup = triggerDatabaseBackup;

  async function triggerDatabaseRestore() {
    if (!supabase) return;
    const fileInput = document.getElementById('backup-file-input');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      showToast(t('toast_choose_backup'), "error");
      return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async function(e) {
      try {
        const jsonContent = e.target.result;
        const parsed = JSON.parse(jsonContent);
        
        if (!parsed.data || typeof parsed.data !== 'object') {
          throw new Error('Invalid backup format. Missing data payload.');
        }
        
        if (confirm(t('confirm_restore_db'))) {
          showLoader();
          const backupData = parsed.data;
          
          // Restore elements
          if (backupData.country_prices && Array.isArray(backupData.country_prices)) {
            await safeDbCall(supabase.from('country_prices').upsert(backupData.country_prices));
          }
          if (backupData.customers && Array.isArray(backupData.customers)) {
            await safeDbCall(supabase.from('customers').upsert(backupData.customers));
          }
          if (backupData.shipments && Array.isArray(backupData.shipments)) {
            await safeDbCall(supabase.from('shipments').upsert(backupData.shipments));
          }
          if (backupData.invoices && Array.isArray(backupData.invoices)) {
            await safeDbCall(supabase.from('invoices').upsert(backupData.invoices));
          }
          
          hideLoader();
          showToast(t('toast_backup_restored'), "success");
          setTimeout(() => window.location.reload(), 1500);
        }
      } catch (err) {
        hideLoader();
        showToast(t('toast_restore_failed') + err.message, "error");
      }
    };

    reader.readAsText(file);
  }

  window.triggerDatabaseRestore = triggerDatabaseRestore;

  // ==========================================================================
  // 10. SYSTEM NAME & USER MANAGEMENT SETTINGS
  // ==========================================================================

  function loadSystemName() {
    const systemName = localStorage.getItem('atlas_system_name') || 'أطلس إكسبريس';
    
    const logoText = document.querySelector('.logo-text');
    if (logoText) logoText.textContent = systemName;

    document.title = `نظام شحن ${systemName} | وكالة نقل الطرود المغرب - أوروبا`;

    const loginTitle = document.querySelector('.login-title');
    if (loginTitle) loginTitle.textContent = `وكالة ${systemName}`;

    const input = document.getElementById('settings-system-name');
    if (input) input.value = systemName;
  }

  async function saveSystemNameSetting() {
    if (!supabase) return;
    const input = document.getElementById('settings-system-name');
    if (!input) return;

    const value = input.value.trim();
    if (!value) return;

    showLoader();
    const { error } = await supabase
      .from('settings')
      .upsert({ key: 'system_name', value: value });

    hideLoader();
    if (error) {
      showToast((currentLang === 'ar' ? "خطأ أثناء حفظ التغييرات: " : "Erreur lors de la sauvegarde : ") + error.message, "error");
    } else {
      localStorage.setItem('atlas_system_name', value);
      loadSystemName();
      showToast(t('toast_sysname_saved'), "success");
    }
  }

  window.saveSystemNameSetting = saveSystemNameSetting;

  function renderUsersSettings() {
    const users = [...cachedUsers].sort((a, b) => a.email.localeCompare(b.email));
    const tableBody = document.getElementById('users-settings-table-body');
    if (!tableBody) return;

    tableBody.innerHTML = '';
    
    users.forEach(u => {
      const isSelf = currentUser && currentUser.id === u.id;
      const roleAr = u.role === 'Admin' ? t('role_admin_val') : t('role_staff_val');
      const dateFormatted = u.created_at ? u.created_at.split('T')[0] : t('date_previous');

      const deleteButton = isSelf 
        ? `<button class="btn-icon" disabled style="opacity:0.3; cursor:not-allowed;" title="${t('title_cannot_delete_self')}"><i class="fa-solid fa-user-slash"></i></button>`
        : `<button class="btn-icon delete" title="${t('title_delete_user')}" onclick="deleteUserSetting('${u.id}')"><i class="fa-solid fa-user-minus"></i></button>`;

      tableBody.innerHTML += `
        <tr>
          <td><strong>${u.name}</strong></td>
          <td style="font-family:'Estedad', sans-serif;">${u.email}</td>
          <td><span class="badge ${u.role === 'Admin' ? 'badge-delivered' : 'badge-transit'}">${roleAr}</span></td>
          <td style="font-size:11px; color:var(--text-secondary);">${dateFormatted}</td>
          <td>
            <div class="actions-cell">
              ${deleteButton}
            </div>
          </td>
        </tr>
      `;
    });
  }

  async function handleAddUser() {
    if (!window.supabase) return;
    const usernameInput = document.getElementById('new-user-username').value.trim().toLowerCase();
    
    // Convert username to email format if simple text provided
    let email = usernameInput;
    if (!email.includes('@')) {
      email = `${usernameInput}@atlas.com`;
    }
    
    const fullnameInput = document.getElementById('new-user-fullname').value.trim();
    const passwordInput = document.getElementById('new-user-password').value;
    const roleInput = document.getElementById('new-user-role').value; // staff / administrator

    let roleMapped = 'Employee';
    if (roleInput === 'administrator' || roleInput === 'Admin') {
      roleMapped = 'Admin';
    }

    if (!email || !fullnameInput || !passwordInput || !roleInput) {
      showToast(t('toast_fields_required'), "error");
      return;
    }

    if (passwordInput.length < 6) {
      showToast(t('toast_password_length'), "error");
      return;
    }

    // Check locally first
    const existing = cachedUsers.find(u => u.email === email);
    if (existing) {
      showToast(t('toast_user_exists'), "error");
      return;
    }

    showLoader();
    // Register in auth.users using a secondary non-persisted client (prevents current Admin logout)
    const secondaryClient = window.supabase.createClient(window.supabaseUrl, window.supabaseKey, {
      auth: { persistSession: false }
    });

    try {
      const { error } = await secondaryClient.auth.signUp({
        email: email,
        password: passwordInput,
        options: {
          data: {
            name: fullnameInput,
            role: roleMapped
          }
        }
      });

      hideLoader();
      if (error) {
        showToast(t('toast_auth_signup_failed') + error.message, "error");
      } else {
        const form = document.getElementById('add-user-form');
        if (form) form.reset();
        showToast(t('toast_user_added'), "success");
      }
    } catch (err) {
      hideLoader();
      console.error(err);
    }
  }

  window.handleAddUser = handleAddUser;

  async function deleteUserSetting(userId) {
    if (!supabase) return;
    const user = cachedUsers.find(u => u.id === userId);
    if (!user) return;

    const confirmMsg = currentLang === 'ar'
      ? `هل أنت متأكد من حذف حساب الموظف "${user.name}" (${user.email}) نهائياً من النظام؟`
      : `Voulez-vous vraiment supprimer le compte de l'employé "${user.name}" (${user.email}) définitivement du système ?`;
    if (confirm(confirmMsg)) {
      showLoader();
      const { error } = await supabase.rpc('delete_user_by_admin', { user_id: userId });
      
      hideLoader();
      if (error) {
        showToast((currentLang === 'ar' ? "خطأ أثناء حذف حساب المستخدم: " : "Erreur lors de la suppression de l'utilisateur : ") + error.message, "error");
      } else {
        showToast(t('toast_user_deleted'), "success");
      }
    }
  }

  window.deleteUserSetting = deleteUserSetting;

  // Initialize language on script run
  changeLanguage(currentLang);

})();
