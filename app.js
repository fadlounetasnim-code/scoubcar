// =========================================================================
// International Cargo & Shipping Agency - App Core Logic
// Integrated with Supabase, Realtime Sync, and Role-Based Permissions
// =========================================================================


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

const STATUS_AR = {
  'received': 'قيد الاستلام',
  'processing': 'قيد المعالجة',
  'transit': 'في الطريق',
  'arrived': 'وصلت بلد الوجهة',
  'delivered': 'تم التسليم',
  'cancelled': 'ملغاة'
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



async function handleLogin() {
  // code
}

window.handleLogin = handleLogin;
  const emailInput = document.getElementById('login-username').value.trim();
  const passwordInput = document.getElementById('login-password').value;
  const errorMsg = document.getElementById('login-error-msg');

  const client = window.supabaseClient;

  if (!client || !client.auth) {
    errorMsg.textContent = "Supabase client غير متصل. تأكد من supabase-client.js";
    errorMsg.style.display = 'block';
    console.error("window.supabaseClient is missing:", window.supabaseClient);
    return;
  }

  const { data, error } = await client.auth.signInWithPassword({
    email: emailInput,
    password: passwordInput
  });

  if (error) {
    errorMsg.textContent = "البريد الإلكتروني أو كلمة المرور غير صحيحة";
    errorMsg.style.display = 'block';
    console.error("Login error:", error);
  } else {
    errorMsg.style.display = 'none';
  }
}

async function handleLogout() {
  // code
}

window.handleLogout = handleLogout;
  if (window.supabaseClient) {
    await window.supabaseClient.auth.signOut();
  }
}
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

// Fetch all database records into memory cache
async function loadAllData() {
  try {
    showLoader();
    const [pricesRes, settingsRes, customersRes, shipmentsRes, invoicesRes] = await Promise.all([
      supabase.from('country_prices').select('*'),
      supabase.from('settings').select('*'),
      supabase.from('customers').select('*'),
      supabase.from('shipments').select('*'),
      supabase.from('invoices').select('*')
    ]);

    cachedCountryPrices = pricesRes.data || [];
    
    cachedSettings = {};
    if (settingsRes.data) {
      settingsRes.data.forEach(s => {
        cachedSettings[s.key] = s.value;
      });
      if (cachedSettings['system_name']) {
        localStorage.setItem('atlas_system_name', cachedSettings['system_name']);
      }
    }

    cachedCustomers = customersRes.data || [];
    cachedShipments = shipmentsRes.data || [];
    cachedInvoices = invoicesRes.data || [];

    if (currentUserRole === 'Admin') {
      const { data: usersData } = await supabase.from('users').select('*');
      cachedUsers = usersData || [];
    }
    
    markAllViewsDirty();
  } catch (err) {
    console.error("Error loading database tables:", err);
  } finally {
    hideLoader();
  }
}

// Subscribe to Supabase database changes in Realtime
function setupRealtime() {
  if (isRealtimeListening) return;
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
  loadSystemName();
  switchView('dashboard');
  
  populateShipmentModalCountries();
  populateShipmentsCountryFilter();

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('report-date-input').value = today;
  document.getElementById('report-month-input').value = today.substring(0, 7);
}

function switchView(viewName) {
  const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
  menuItems.forEach(item => item.classList.remove('active'));
  
  const targetMenu = document.getElementById(`menu-${viewName}`);
  if (targetMenu) targetMenu.classList.add('active');

  const panels = document.querySelectorAll('.view-panel');
  panels.forEach(panel => panel.classList.remove('active'));
  
  const targetPanel = document.getElementById(`view-${viewName}`);
  if (targetPanel) targetPanel.classList.add('active');

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
      pageTitle.textContent = 'لوحة التحكم';
      pageSubtitle.textContent = 'نظرة عامة على نشاط وكالة الشحن الدولي اليوم';
      if (shouldRender || viewDirtyState['dashboard']) {
        renderDashboard();
        viewDirtyState['dashboard'] = false;
      }
      break;
    case 'shipments':
      pageTitle.textContent = 'الطرود والشحنات';
      pageSubtitle.textContent = 'إدارة ومتابعة الشحنات والطرود الصادرة إلى أوروبا';
      if (shouldRender || viewDirtyState['shipments']) {
        renderShipments();
        viewDirtyState['shipments'] = false;
      }
      break;
    case 'customers':
      pageTitle.textContent = 'إدارة العملاء';
      pageSubtitle.textContent = 'تسجيل وإدارة العملاء بالوكالة ومراجعة سجلات شحنهم';
      if (shouldRender || viewDirtyState['customers']) {
        renderCustomers();
        viewDirtyState['customers'] = false;
      }
      break;
    case 'pricing':
      pageTitle.textContent = 'تعرفة الشحن للدول الأوروبية';
      pageSubtitle.textContent = 'تعديل وتحديد تسعيرة الشحن لكل بلد أوروبي بالدرهم';
      if (shouldRender || viewDirtyState['pricing']) {
        renderPricingSettings();
        viewDirtyState['pricing'] = false;
      }
      break;
    case 'reports':
      pageTitle.textContent = 'التقارير المالية والنشاط';
      pageSubtitle.textContent = 'استعراض تقارير الأرباح والشحنات وتصديرها PDF أو Excel';
      if (shouldRender || viewDirtyState['reports']) {
        generateReportData();
        viewDirtyState['reports'] = false;
      }
      break;
    case 'settings':
      pageTitle.textContent = 'الإعدادات والنسخ الاحتياطي';
      pageSubtitle.textContent = 'أدوات الصيانة، النسخ الاحتياطي لقاعدة البيانات واستعادتها';
      if (shouldRender || viewDirtyState['settings']) {
        renderUsersSettings();
        viewDirtyState['settings'] = false;
      }
      break;
  }
}

function refreshActiveView() {
  switch (currentView) {
    case 'dashboard':
      renderDashboard();
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
  document.getElementById('kpi-total-shipments').textContent = totalCount;
  document.getElementById('kpi-transit-shipments').textContent = pendingCount;
  document.getElementById('kpi-delivered-shipments').textContent = deliveredCount;
  document.getElementById('kpi-cancelled-shipments').textContent = cancelledCount;
  
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
  recentTable.innerHTML = '';

  const sortedShipments = [...shipments]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);

  if (sortedShipments.length === 0) {
    recentTable.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-secondary);">لا توجد شحنات مسجلة حالياً بالوكالة</td></tr>`;
  } else {
    let recentHtml = '';
    sortedShipments.forEach(s => {
      const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
      const flag = countryObj ? countryObj.flag : '';
      const countryName = countryObj ? countryObj.country_name : s.destination_country;

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
          <td>${s.weight} كجم (${s.quantity} طرود)</td>
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

  // Country Breakdown Stats
  const countryBreakdown = document.getElementById('dashboard-country-breakdown');
  countryBreakdown.innerHTML = '';

  const activeCountries = cachedCountryPrices.filter(c => c.is_active === true);
  const countryStats = [];
  
  activeCountries.forEach(c => {
    const count = shipments.filter(s => s.destination_country === c.country_code).length;
    if (count > 0) {
      countryStats.push({
        name: c.country_name,
        flag: c.flag,
        count: count
      });
    }
  });

  countryStats.sort((a, b) => b.count - a.count);

  if (countryStats.length === 0) {
    countryBreakdown.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-secondary); font-size:12px;">لا توجد إحصائيات شحنات حالياً بالدول</div>`;
  } else {
    let breakdownHtml = '';
    countryStats.slice(0, 5).forEach(stat => {
      const percentage = totalCount > 0 ? (stat.count / totalCount) * 100 : 0;
      breakdownHtml += `
        <div style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; justify-content:space-between; font-size:12px;">
            <span style="font-weight:700;">${stat.flag} ${stat.name}</span>
            <span style="color:var(--text-secondary); font-family:'Estedad', sans-serif; font-weight:700;">${stat.count} شحنات (${percentage.toFixed(0)}%)</span>
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
  const searchQuery = document.getElementById('shipment-search').value.trim().toLowerCase();
  const countryFilter = document.getElementById('shipment-country-filter').value;
  const statusFilter = document.getElementById('shipment-status-filter').value;
  
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
  tableBody.innerHTML = '';

  const totalFilteredCount = shipments.length;
  const displayedShipments = shipments.slice(0, shipmentsLimit);

  if (displayedShipments.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-secondary);">لا توجد شحنات مطابقة لخيارات البحث المحددة</td></tr>`;
    const pagContainer = document.getElementById('shipments-pagination');
    if (pagContainer) pagContainer.style.display = 'none';
    return;
  }

  let tableHtml = '';
  displayedShipments.forEach(s => {
    const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
    const flag = countryObj ? countryObj.flag : '';
    const countryName = countryObj ? countryObj.country_name : s.destination_country;

    // Permission check for modifying shipment: admin can edit all, employee only their own
    const isOwnShipment = currentUser && s.employee_id === currentUser.id;
    const canEdit = currentUserRole === 'Admin' || isOwnShipment;
    const canDelete = currentUserRole === 'Admin';

    const editBtn = canEdit 
      ? `<button class="btn-icon" title="تعديل" onclick="openEditShipmentModal('${s.tracking_number}')"><i class="fa-solid fa-pen-to-square"></i></button>`
      : `<button class="btn-icon" disabled style="opacity:0.3; cursor:not-allowed;" title="لا يمكنك تعديل شحنات غيرك"><i class="fa-solid fa-pen-to-square"></i></button>`;
      
    const deleteBtn = canDelete
      ? `<button class="btn-icon delete" title="حذف الشحنة" onclick="deleteShipmentData('${s.tracking_number}')"><i class="fa-solid fa-trash-can"></i></button>`
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
          <div style="font-weight:700;">${s.weight} كجم</div>
          <div style="font-size:11px; color:var(--text-secondary);">${s.quantity} طرود</div>
        </td>
        <td style="font-family:'Estedad', sans-serif; font-weight:800; font-size:14px; color:var(--text-dark);">${formatMAD(s.shipping_price)}</td>
        <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
        <td>
          <div class="actions-cell">
            <button class="btn-icon" title="الفاتورة" onclick="openInvoiceModal('${s.tracking_number}')"><i class="fa-solid fa-file-invoice"></i></button>
            <button class="btn-icon" title="تحديث الحالة" onclick="openStatusModal('${s.tracking_number}')"><i class="fa-solid fa-route"></i></button>
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
        <span class="pagination-info">يعرض ${displayedShipments.length} من أصل ${totalFilteredCount} شحنة</span>
        <button class="btn-load-more" onclick="loadMoreShipments()">
          <i class="fa-solid fa-spinner"></i> تحميل المزيد
        </button>
      `;
    } else {
      paginationContainer.style.display = 'none';
    }
  }
}

function loadMoreShipments() {
  shipmentsLimit += 50;
  filterShipments(false);
}

function openNewShipmentModal() {
  currentEditingShipment = null;
  document.getElementById('shipment-modal-title').textContent = 'تسجيل طرد شحن جديد';
  
  const newCode = generateTrackingNumber();
  document.getElementById('shipment-tracking-display').textContent = newCode;
  
  populateCustomersDropdown('shipment-sender-select');

  document.getElementById('shipment-form').reset();
  document.getElementById('shipment-edit-id').value = '';
  document.getElementById('shipment-price').value = '';
  document.getElementById('price-calc-hint').textContent = 'قم باختيار الدولة وتحديد الوزن لحساب التسعير';
  
  document.getElementById('shipment-modal').showModal();
}

function openEditShipmentModal(trackingNumber) {
  const shipment = cachedShipments.find(s => s.tracking_number === trackingNumber);
  if (!shipment) return;

  currentEditingShipment = shipment;
  document.getElementById('shipment-modal-title').textContent = 'تعديل بيانات الشحنة';
  document.getElementById('shipment-tracking-display').textContent = shipment.tracking_number;

  populateCustomersDropdown('shipment-sender-select', shipment.sender_customer_id);

  document.getElementById('shipment-edit-id').value = shipment.tracking_number;
  document.getElementById('shipment-sender-name').value = shipment.sender_name;
  document.getElementById('shipment-sender-phone').value = shipment.sender_phone;
  document.getElementById('shipment-receiver-name').value = shipment.receiver_name;
  document.getElementById('shipment-receiver-phone').value = shipment.receiver_phone;
  document.getElementById('shipment-country').value = shipment.destination_country;
  document.getElementById('shipment-city').value = shipment.city;
  document.getElementById('shipment-address').value = shipment.full_address;
  document.getElementById('shipment-quantity').value = shipment.quantity;
  document.getElementById('shipment-weight').value = shipment.weight;
  document.getElementById('shipment-price').value = shipment.shipping_price;
  document.getElementById('shipment-status').value = shipment.status;
  document.getElementById('shipment-notes').value = shipment.notes || '';

  document.getElementById('price-calc-hint').textContent = 'سعر الشحن المعتمد لهذه الشحنة حالياً';
  document.getElementById('shipment-modal').showModal();
}

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
  const customerId = select.value;
  
  const nameInput = document.getElementById('shipment-sender-name');
  const phoneInput = document.getElementById('shipment-sender-phone');

  if (customerId) {
    const cust = cachedCustomers.find(c => c.id === customerId);
    if (cust) {
      nameInput.value = cust.name;
      phoneInput.value = cust.phone;
    }
  } else {
    nameInput.value = '';
    phoneInput.value = '';
  }
}

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
  priceInput.value = finalPrice;
  calcHint.textContent = `السعر التلقائي: الأساسي (${rate.base_price} DH) + الوزن (${rate.price_per_kg} DH/كجم) + الطرود الإضافية.`;
}

async function saveShipmentData() {
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

  if (editId) {
    // Update shipment on Supabase
    const s = cachedShipments.find(ship => ship.tracking_number === editId);
    if (!s) return;
    
    let history = [...s.status_history];
    if (s.status !== status) {
      history.push({
        status: status,
        date: new Date().toISOString(),
        note: 'تم تعديل تفاصيل الحالة'
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
      
    if (error) {
      alert("خطأ أثناء حفظ تعديلات الشحنة: " + error.message);
    } else {
      document.getElementById('shipment-modal').close();
    }
  } else {
    // Insert new shipment on Supabase
    const trackingNumber = document.getElementById('shipment-tracking-display').textContent;
    const history = [{
      status: status,
      date: new Date().toISOString(),
      note: 'تسجيل الشحنة بالمستودع'
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
      alert("خطأ أثناء تسجيل الشحنة الجديدة: " + error.message);
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
    
    await supabase.from('invoices').insert(newInvoice);
    document.getElementById('shipment-modal').close();
  }
}

async function deleteShipmentData(trackingNumber) {
  if (confirm(`هل أنت متأكد من حذف الشحنة رقم ${trackingNumber} نهائياً من قاعدة البيانات؟`)) {
    const { error } = await supabase
      .from('shipments')
      .delete()
      .eq('tracking_number', trackingNumber);
      
    if (error) {
      alert("خطأ أثناء حذف الشحنة: " + error.message);
    }
  }
}

// ==========================================================================
// 4. STATUS CHANGE OVERLAYS
// ==========================================================================

function openStatusModal(trackingNumber) {
  const s = cachedShipments.find(ship => ship.tracking_number === trackingNumber);
  if (!s) return;

  document.getElementById('status-update-tracking').value = trackingNumber;
  document.getElementById('status-update-select').value = s.status;
  document.getElementById('status-update-note').value = '';

  document.getElementById('status-modal').showModal();
}

async function saveStatusUpdate() {
  const trackingNumber = document.getElementById('status-update-tracking').value;
  const newStatus = document.getElementById('status-update-select').value;
  const noteText = document.getElementById('status-update-note').value.trim() || 'تحديث روتيني لحالة الشحن';

  const s = cachedShipments.find(ship => ship.tracking_number === trackingNumber);
  if (!s) return;

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

  if (error) {
    alert("خطأ أثناء تحديث حالة الشحنة: " + error.message);
  } else {
    document.getElementById('status-modal').close();
  }
}

// ==========================================================================
// 5. CUSTOMERS MANAGEMENT
// ==========================================================================

function renderCustomers() {
  filterCustomers();
}

function filterCustomers() {
  const searchQuery = document.getElementById('customer-search').value.trim().toLowerCase();
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
  tableBody.innerHTML = '';

  if (customers.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-secondary);">لا توجد عملاء مسجلين يطابقون مدخلات البحث</td></tr>`;
    return;
  }

  customers.forEach(c => {
    const deleteBtn = currentUserRole === 'Admin'
      ? `<button class="btn-icon delete" title="حذف العميل" onclick="deleteCustomerData('${c.id}')"><i class="fa-solid fa-user-xmark"></i></button>`
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
        <td style="font-family:'Estedad', sans-serif; font-weight:700;">${c.shipments_count} شحنات</td>
        <td>
          <div class="actions-cell">
            <button class="btn-icon" title="سجل الشحنات" onclick="openCustomerHistory('${c.id}')"><i class="fa-solid fa-list-check"></i></button>
            <button class="btn-icon" title="تعديل" onclick="openEditCustomerModal('${c.id}')"><i class="fa-solid fa-pen-to-square"></i></button>
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
  });
}

function openNewCustomerModal() {
  currentEditingCustomer = null;
  document.getElementById('customer-modal-title').textContent = 'إضافة عميل جديد بالوكالة';
  document.getElementById('customer-form').reset();
  document.getElementById('customer-edit-id').value = '';
  document.getElementById('customer-modal').showModal();
}

function openEditCustomerModal(customerId) {
  const cust = cachedCustomers.find(c => c.id === customerId);
  if (!cust) return;

  currentEditingCustomer = cust;
  document.getElementById('customer-modal-title').textContent = 'تعديل بيانات العميل';
  
  document.getElementById('customer-edit-id').value = cust.id;
  document.getElementById('customer-name').value = cust.name;
  document.getElementById('customer-phone').value = cust.phone;
  document.getElementById('customer-email').value = cust.email || '';
  document.getElementById('customer-morocco-id').value = cust.morocco_id;
  document.getElementById('customer-address').value = cust.address || '';

  document.getElementById('customer-modal').showModal();
}

async function saveCustomerData() {
  const editId = document.getElementById('customer-edit-id').value;
  const name = document.getElementById('customer-name').value.trim();
  const phone = document.getElementById('customer-phone').value.trim();
  const email = document.getElementById('customer-email').value.trim();
  const moroccoId = document.getElementById('customer-morocco-id').value.trim().toUpperCase();
  const address = document.getElementById('customer-address').value.trim();

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
      
    if (error) {
      alert("خطأ أثناء تحديث بيانات العميل: " + error.message);
    } else {
      document.getElementById('customer-modal').close();
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
      
    if (error) {
      alert("خطأ أثناء إضافة العميل الجديد: " + error.message);
    } else {
      document.getElementById('customer-modal').close();
    }
  }
}

async function deleteCustomerData(customerId) {
  const cust = cachedCustomers.find(c => c.id === customerId);
  if (!cust) return;

  if (cust.shipments_count > 0) {
    alert(`لا يمكن حذف هذا العميل نظراً لوجود شحنات مسجلة باسمه (${cust.shipments_count}) شحنات.`);
    return;
  }

  if (confirm(`هل أنت متأكد من حذف العميل "${cust.name}" نهائياً؟`)) {
    const { error } = await supabase
      .from('customers')
      .delete()
      .eq('id', customerId);
      
    if (error) {
      alert("خطأ أثناء حذف العميل: " + error.message);
    }
  }
}

function openCustomerHistory(customerId) {
  const cust = cachedCustomers.find(c => c.id === customerId);
  if (!cust) return;

  document.getElementById('history-modal-title').textContent = `سجل شحنات العميل: ${cust.name}`;

  const shipments = cachedShipments
    .filter(s => s.sender_customer_id === customerId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const tableBody = document.getElementById('history-table-body');
  tableBody.innerHTML = '';

  if (shipments.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-secondary);">لا توجد شحنات سابقة مسجلة باسم هذا العميل</td></tr>`;
  } else {
    shipments.forEach(s => {
      const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
      const flag = countryObj ? countryObj.flag : '';
      const countryName = countryObj ? countryObj.country_name : s.destination_country;

      tableBody.innerHTML += `
        <tr>
          <td style="font-family:'Estedad', sans-serif; font-weight:700; color:var(--primary-color);">${s.tracking_number}</td>
          <td style="font-size:11px;">${s.created_at.split('T')[0]}</td>
          <td><strong>${s.receiver_name}</strong></td>
          <td>${flag} ${countryName}</td>
          <td>${s.weight} كجم</td>
          <td style="font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
          <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
        </tr>
      `;
    });
  }

  document.getElementById('history-modal').showModal();
}

// ==========================================================================
// 6. PRICING SETTINGS LOGIC
// ==========================================================================

function renderPricingSettings() {
  filterPricingList();
}

function filterPricingList() {
  const searchQuery = document.getElementById('pricing-search').value.trim().toLowerCase();
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
  container.innerHTML = '';

  if (countries.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-secondary);">لا توجد دول مطابقة لمدخلات البحث</div>`;
    return;
  }

  const isAdmin = currentUserRole === 'Admin';
  const disabledAttr = isAdmin ? '' : 'disabled';
  const saveBtn = isAdmin 
    ? (cCode) => `<button class="btn-primary" style="padding: 8px 16px; font-size:11px;" onclick="saveCountryPriceRate('${cCode}')"><i class="fa-solid fa-floppy-disk"></i> حفظ</button>`
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

async function saveCountryPriceRate(countryCode) {
  const basePriceVal = parseFloat(document.getElementById(`base-price-${countryCode}`).value) || 0;
  const perKgVal = parseFloat(document.getElementById(`per-kg-${countryCode}`).value) || 0;

  const { error } = await supabase
    .from('country_prices')
    .update({
      base_price: basePriceVal,
      price_per_kg: perKgVal
    })
    .eq('country_code', countryCode);

  if (error) {
    alert("خطأ أثناء حفظ تعديل السعر: " + error.message);
  } else {
    const row = document.getElementById(`pricing-row-${countryCode}`);
    row.style.borderColor = 'var(--color-success)';
    row.style.backgroundColor = '#e8f5e9';
    
    setTimeout(() => {
      row.style.borderColor = 'var(--border-light)';
      row.style.backgroundColor = 'var(--light-bg)';
    }, 1500);
  }
}

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
  const countryName = countryObj ? countryObj.country_name : s.destination_country;

  const invoicePrintArea = document.getElementById('invoice-print-area');
  
  invoicePrintArea.innerHTML = `
    <div class="invoice-header">
      <div class="invoice-logo-section">
        <div class="invoice-logo">
          <i class="fa-solid fa-paper-plane"></i>
        </div>
        <div>
          <h1 class="invoice-company-name">وكالة أطلس إكسبريس</h1>
          <p class="invoice-company-sub">لنقل الطرود والشحنات الدولية نحو أوروبا</p>
        </div>
      </div>
      <div class="invoice-meta">
        <h2 class="invoice-title-text">وصل شحن طرد</h2>
        <div class="invoice-number">رقم الفاتورة: <span style="font-family:'Estedad', sans-serif;">${invoiceNum}</span></div>
        <div class="invoice-date">تاريخ الإرسال: ${s.created_at.split('T')[0]}</div>
      </div>
    </div>

    <div class="invoice-parties">
      <div class="party-box">
        <div class="party-title">المرسل (المغرب)</div>
        <div class="party-name">${s.sender_name}</div>
        <div class="party-details">
          <span>الهاتف: ${s.sender_phone}</span>
          <span>الهوية الوطنية: ${s.notes || '--'}</span>
        </div>
      </div>

      <div class="party-box">
        <div class="party-title">المستلم (أوروبا)</div>
        <div class="party-name">${s.receiver_name}</div>
        <div class="party-details">
          <span>البلد: ${flag} ${countryName}</span>
          <span>المدينة: ${s.city}</span>
          <span>الهاتف: ${s.receiver_phone}</span>
          <span>العنوان: ${s.full_address}</span>
        </div>
      </div>
    </div>

    <table class="invoice-table">
      <thead>
        <tr>
          <th>تفاصيل الشحنة والخدمة</th>
          <th style="text-align:center;">الوزن</th>
          <th style="text-align:center;">عدد الطرود</th>
          <th style="text-align:left;">المبلغ الفرعي</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <strong>شحن دولي جوي وبري سريع</strong><br>
            <span style="font-size:11px; color:#555;">من المغرب نحو ${countryName} (رقم التتبع: ${s.tracking_number})</span>
          </td>
          <td style="text-align:center; font-family:'Estedad', sans-serif;">${s.weight} كجم</td>
          <td style="text-align:center; font-family:'Estedad', sans-serif;">${s.quantity}</td>
          <td style="text-align:left; font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
        </tr>
      </tbody>
    </table>

    <div class="invoice-totals">
      <div class="total-row">
        <span>السعر الخاضع للضريبة:</span>
        <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price * 0.8)}</span>
      </div>
      <div class="total-row">
        <span>الضريبة المضافة (20%):</span>
        <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price * 0.2)}</span>
      </div>
      <div class="total-row grand-total">
        <span>المجموع الإجمالي:</span>
        <span style="font-family:'Estedad', sans-serif;">${formatMAD(s.shipping_price)}</span>
      </div>
    </div>

    <div style="background-color:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; padding:12px; margin-bottom:30px; text-align:center; font-weight:700; color:#2e7d32; display:flex; align-items:center; justify-content:center; gap:8px;">
      <i class="fa-solid fa-circle-check"></i> تم تسديد ثمن الشحن بالكامل بالدرهم المغربي (DH)
    </div>

    <div class="invoice-footer">
      <p>شكراً لثقتكم بوكالة أطلس للشحن الدولي. لأي استفسار يرجى التواصل عبر الرقم الموحد بالوكالة.</p>
      <p style="margin-top:6px; font-size:10px; color:#a1a1a6;">Atlas Cargo System - Supabase Realtime Engine</p>
    </div>
  `;

  document.getElementById('invoice-modal').showModal();
}

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

function generateReportData() {
  const type = document.getElementById('report-type').value;
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
          <span class="kpi-title">الشحنات بالتقرير</span>
          <span class="kpi-value">${totalCount} شحنات</span>
        </div>
        <div class="kpi-icon kpi-all"><i class="fa-solid fa-boxes-stacked"></i></div>
      </div>

      <div class="kpi-card">
        <div class="kpi-info">
          <span class="kpi-title">الوزن الإجمالي المشحون</span>
          <span class="kpi-value">${totalWeight.toFixed(1)} كجم</span>
        </div>
        <div class="kpi-icon kpi-transit"><i class="fa-solid fa-weight-scale"></i></div>
      </div>

      <div class="kpi-card">
        <div class="kpi-info">
          <span class="kpi-title">مداخيل الشحن (MAD)</span>
          <span class="kpi-value">${formatMAD(grossBilling)}</span>
        </div>
        <div class="kpi-icon kpi-delivered"><i class="fa-solid fa-chart-line"></i></div>
      </div>

      <div class="kpi-card">
        <div class="kpi-info">
          <span class="kpi-title">صافي الأرباح المقدرة (35%)</span>
          <span class="kpi-value" style="color:var(--color-success);">${formatMAD(estimatedProfit)}</span>
        </div>
        <div class="kpi-icon kpi-revenue"><i class="fa-solid fa-hand-holding-dollar"></i></div>
      </div>
    `;
  }

  const tableBody = document.getElementById('report-table-body');
  tableBody.innerHTML = '';

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-secondary);">لا توجد شحنات مسجلة في هذا النطاق الزمني</td></tr>`;
    return;
  }

  filtered.forEach(s => {
    const countryObj = cachedCountryPrices.find(c => c.country_code === s.destination_country);
    const flag = countryObj ? countryObj.flag : '';
    const countryName = countryObj ? countryObj.country_name : s.destination_country;

    tableBody.innerHTML += `
      <tr>
        <td style="font-family:'Estedad', sans-serif; font-weight:700;">${s.tracking_number}</td>
        <td>${s.created_at.split('T')[0]}</td>
        <td><strong>${s.sender_name}</strong></td>
        <td>${s.receiver_name}</td>
        <td>${flag} ${countryName} - ${s.city}</td>
        <td style="font-family:'Estedad', sans-serif;">${s.weight} كجم</td>
        <td style="font-family:'Estedad', sans-serif; font-weight:700;">${formatMAD(s.shipping_price)}</td>
        <td><span class="badge badge-${s.status}">${STATUS_AR[s.status]}</span></td>
      </tr>
    `;
  });
}

function printReport() {
  window.print();
}

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
    alert('لا توجد بيانات لتصديرها بالتقرير المختار');
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
}

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
  } catch (e) {
    alert('فشل تصدير النسخة الاحتياطية لقاعدة البيانات: ' + e.message);
  }
}

async function triggerDatabaseRestore() {
  const fileInput = document.getElementById('backup-file-input');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('يرجى اختيار ملف النسخة الاحتياطية (.json) أولاً.');
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
      
      if (confirm('تنبيه: سيتم دمج/استرجاع هذه البيانات مباشرة على قاعدة بيانات Supabase. هل ترغب في الاستمرار؟')) {
        const backupData = parsed.data;
        
        // Restore elements
        if (backupData.country_prices && Array.isArray(backupData.country_prices)) {
          await supabase.from('country_prices').upsert(backupData.country_prices);
        }
        if (backupData.customers && Array.isArray(backupData.customers)) {
          await supabase.from('customers').upsert(backupData.customers);
        }
        if (backupData.shipments && Array.isArray(backupData.shipments)) {
          await supabase.from('shipments').upsert(backupData.shipments);
        }
        if (backupData.invoices && Array.isArray(backupData.invoices)) {
          await supabase.from('invoices').upsert(backupData.invoices);
        }
        
        alert('تمت استعادة النسخة الاحتياطية بنجاح على قاعدة بيانات Supabase!');
        window.location.reload();
      }
    } catch (err) {
      alert('فشل استعادة البيانات. تأكد من صحة وسلامة الملف المختار: ' + err.message);
    }
  };

  reader.readAsText(file);
}

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
  const input = document.getElementById('settings-system-name');
  if (!input) return;

  const value = input.value.trim();
  if (!value) return;

  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'system_name', value: value });

  if (error) {
    alert("خطأ أثناء حفظ التغييرات: " + error.message);
  } else {
    localStorage.setItem('atlas_system_name', value);
    loadSystemName();
    alert('تم حفظ اسم النظام الجديد بنجاح.');
  }
}

function renderUsersSettings() {
  const users = [...cachedUsers].sort((a, b) => a.email.localeCompare(b.email));
  const tableBody = document.getElementById('users-settings-table-body');
  if (!tableBody) return;

  tableBody.innerHTML = '';
  
  users.forEach(u => {
    const isSelf = currentUser && currentUser.id === u.id;
    const roleAr = u.role === 'Admin' ? 'مدير كامل الصلاحيات' : 'موظف وكالة';
    const dateFormatted = u.created_at ? u.created_at.split('T')[0] : 'سابق';

    const deleteButton = isSelf 
      ? `<button class="btn-icon" disabled style="opacity:0.3; cursor:not-allowed;" title="لا يمكنك حذف حسابك الحالي"><i class="fa-solid fa-user-slash"></i></button>`
      : `<button class="btn-icon delete" title="حذف المستخدم" onclick="deleteUserSetting('${u.id}')"><i class="fa-solid fa-user-minus"></i></button>`;

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
    alert('يرجى ملء جميع الحقول المطلوبة.');
    return;
  }

  // Check locally first
  const existing = cachedUsers.find(u => u.email === email);
  if (existing) {
    alert('البريد الإلكتروني/المستخدم مسجل بالفعل بالوكالة.');
    return;
  }

  // Register in auth.users using a secondary non-persisted client (prevents current Admin logout)
  const secondaryClient = supabase.createClient(window.supabaseUrl, window.supabaseKey, {
    auth: { persistSession: false }
  });

  const { data, error } = await secondaryClient.auth.signUp({
    email: email,
    password: passwordInput,
    options: {
      data: {
        name: fullnameInput,
        role: roleMapped
      }
    }
  });

  if (error) {
    alert("فشل تسجيل المستخدم الجديد في Supabase Auth: " + error.message);
  } else {
    document.getElementById('add-user-form').reset();
    alert('تم إضافة الموظف الجديد بنجاح في نظام الوكالة.');
  }
}

async function deleteUserSetting(userId) {
  const user = cachedUsers.find(u => u.id === userId);
  if (!user) return;

  if (confirm(`هل أنت متأكد من حذف حساب الموظف "${user.name}" (${user.email}) نهائياً من النظام؟`)) {
    const { error } = await supabase.rpc('delete_user_by_admin', { user_id: userId });
    
    if (error) {
      alert("خطأ أثناء حذف حساب المستخدم: " + error.message);
    } else {
      alert('تم حذف المستخدم بنجاح.');
    }
  }
}
