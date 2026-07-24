// ==UserScript==
// @name         Torn Faction Armory Recaller
// @namespace    Considious [3853023]
// @version      1.2.6
// @description  Manually retrieves one eligible ranked faction weapon or armor item per click.
// @author       Considious [3853023]
// @updateURL    https://raw.githubusercontent.com/Considious/Torn-Scripts-Public/main/Torn-Faction-Armory-Recaller.user.js
// @downloadURL  https://raw.githubusercontent.com/Considious/Torn-Scripts-Public/main/Torn-Faction-Armory-Recaller.user.js
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/faction.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const MODES = Object.freeze({
        RANKED_ALL: 'ranked-all',
        RANKED_NO_PROF: 'ranked-no-prof',
        PROFICIENCE_15_PLUS: 'proficience-15-plus',
    });

    const SETTINGS = Object.freeze({
        apiKey: 'considious_armory_recaller_api_key',
        mode: 'considious_armory_recaller_mode',
        memberCache: 'considious_armory_recaller_member_cache_v4_alphabetical_rank_order',
        rankOrder: 'considious_armory_recaller_displayed_rank_order',
        panelPosition: 'considious_armory_recaller_panel_position',
        whitelist: 'considious_armory_recaller_whitelist',
        minimized: 'considious_armory_recaller_minimized',
    });

    const PANEL_ID = 'considious-armory-recaller';
    const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

    let busy = false;
    let memberLevels = new Map();
    let factionMembers = [];
    let whitelist = new Set(loadWhitelist());

    function loadWhitelist() {
        const saved = GM_getValue(SETTINGS.whitelist, []);
        return Array.isArray(saved) ? saved.map(String) : [];
    }

    function saveWhitelist() {
        GM_setValue(SETTINGS.whitelist, [...whitelist]);
        updateWhitelistCount();
    }

    function pageIsFocused() {
        return document.visibilityState === 'visible' && document.hasFocus();
    }

    function activeArmoryTab() {
        const candidates = [
            document.querySelector('[id="tab=armoury&sub=weapons"]'),
            document.querySelector('[id="tab=armoury&sub=armour"]'),
        ].filter(Boolean);

        return candidates.find((tab) => {
            const style = getComputedStyle(tab);
            return tab.getAttribute('aria-hidden') !== 'true' && style.display !== 'none';
        }) || null;
    }

    function activeTabKind(tab) {
        if (!tab) return null;
        if (tab.id.includes('sub=weapons')) return 'weapons';
        if (tab.id.includes('sub=armour')) return 'armour';
        return null;
    }

    function getRows(tab) {
        return tab ? [...tab.querySelectorAll('ul.item-list > li')] : [];
    }

    function borrowerFromRow(row) {
        const link = row.querySelector('.loaned a[href*="XID="]');
        const match = link?.getAttribute('href')?.match(/[?&]XID=(\d+)/i);
        if (!link || !match) return null;
        return { id: match[1], name: link.textContent.trim() || match[1] };
    }

    function itemName(row) {
        return row.querySelector('.name')?.textContent.trim() || 'item';
    }

    function isRanked(row) {
        const image = row.querySelector('.img-wrap img.torn-item');
        return Boolean(image && ['glow-yellow', 'glow-orange', 'glow-red'].some((c) => image.classList.contains(c)));
    }

    function isProficience(row) {
        return Boolean(row.querySelector('.bonus-attachment-experience'));
    }

    function retrieveControls(row) {
        return {
            open: row.querySelector('.item-action [data-role="retrieve"].active'),
            confirm: row.querySelector('.retrieve-cont .retrieve-yes'),
        };
    }

    function rowIsEligible(row, tabKind, mode) {
        const borrower = borrowerFromRow(row);
        if (!borrower) return { eligible: false, reason: 'not loaned' };
        if (whitelist.has(borrower.id)) return { eligible: false, reason: 'whitelisted' };
        if (!retrieveControls(row).open) return { eligible: false, reason: 'not retrievable' };
        if (!isRanked(row)) return { eligible: false, reason: 'not ranked' };

        const proficiency = isProficience(row);
        if (mode === MODES.RANKED_ALL) return { eligible: true, borrower };
        if (mode === MODES.RANKED_NO_PROF) {
            return proficiency ? { eligible: false, reason: 'proficience weapon' } : { eligible: true, borrower };
        }
        if (mode === MODES.PROFICIENCE_15_PLUS) {
            if (tabKind !== 'weapons') return { eligible: false, reason: 'weapon mode only' };
            if (!proficiency) return { eligible: false, reason: 'not proficience' };
            const level = memberLevels.get(borrower.id);
            if (!Number.isFinite(level)) return { eligible: false, reason: 'level unavailable' };
            if (level < 15) return { eligible: false, reason: 'below level 15' };
            return { eligible: true, borrower };
        }
        return { eligible: false, reason: 'unknown mode' };
    }

    function setStatus(message, state = 'normal') {
        const status = document.querySelector(`#${PANEL_ID} .car-status`);
        if (!status) return;
        status.textContent = message;
        status.dataset.state = state;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function retrieveOne(row, borrower) {
        const open = retrieveControls(row).open;
        if (!open) throw new Error('Retrieve control was not found.');
        setStatus(`Retrieving ${itemName(row)} from ${borrower.name}…`);
        open.click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await sleep(50);
            const confirm = row.querySelector('.retrieve-cont .retrieve-yes');
            if (confirm && confirm.getClientRects().length > 0) {
                confirm.click();
                return;
            }
        }
        throw new Error('Torn did not display the retrieval confirmation.');
    }

    async function handleRetrieveClick() {
        if (busy) return;
        busy = true;
        try {
            if (!pageIsFocused()) return setStatus('Page is not focused. Nothing was scanned.', 'error');
            const tab = activeArmoryTab();
            const tabKind = activeTabKind(tab);
            if (!tab || !tabKind) return setStatus('Open the Weapons or Armor armory tab.', 'error');
            const mode = document.querySelector(`#${PANEL_ID} .car-mode`)?.value || MODES.RANKED_ALL;
            if (mode === MODES.PROFICIENCE_15_PLUS && !(await ensureFactionMembers())) return;
            if (!pageIsFocused()) return setStatus('Page lost focus. Nothing was retrieved.', 'error');

            let skippedWhitelist = 0;
            for (const row of getRows(tab)) {
                const result = rowIsEligible(row, tabKind, mode);
                if (!result.eligible) {
                    if (result.reason === 'whitelisted') skippedWhitelist += 1;
                    continue;
                }
                await retrieveOne(row, result.borrower);
                setStatus(`Retrieved one ${itemName(row)} from ${result.borrower.name}.`, 'success');
                return;
            }
            setStatus(skippedWhitelist ? `No eligible items. Skipped ${skippedWhitelist} whitelisted loan${skippedWhitelist === 1 ? '' : 's'}.` : 'No eligible items remain on this page.', 'done');
        } catch (error) {
            console.error('[Armory RecCaller]', error);
            setStatus(error?.message || 'Retrieval failed.', 'error');
        } finally {
            busy = false;
        }
    }

    function findNextPageControl(tab) {
        const roots = [tab, document.querySelector('#faction-armoury'), document].filter(Boolean);
        const selectors = [
            '.gallery-wrapper.pagination a[href] > i.pagination-right',
            '.pagination a[href] > i.pagination-right',
            '.pagination a.next:not(.disabled)',
            '.pagination .next:not(.disabled) a',
            'a[aria-label="Next"]',
            'a[title="Next"]',
            '[data-page="next"]',
        ];

        for (const root of roots) {
            for (const selector of selectors) {
                const found = root.querySelector(selector);
                if (!found) continue;
                const control = found.matches('a, button') ? found : found.closest('a, button');
                if (!control || control.classList.contains('disable') || control.classList.contains('disabled')) continue;
                return control;
            }
        }

        return [...(tab?.querySelectorAll('a, button') || [])].find((el) => {
            const values = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].map((v) => (v || '').trim().toLowerCase());
            return values.includes('next');
        }) || null;
    }

    function handleNextPageClick() {
        if (!pageIsFocused()) return setStatus('Page is not focused. Page was not changed.', 'error');
        const tab = activeArmoryTab();
        if (!tab) return setStatus('Open the Weapons or Armor armory tab.', 'error');
        const next = findNextPageControl(tab);
        if (!next) return setStatus('No enabled Next Page control was found.', 'done');

        const href = next.getAttribute('href');
        next.click();

        // Torn's armory pagination is hash-routed. Fall back to assigning the
        // exact href when another script prevents the synthetic click.
        if (href?.startsWith('#') && window.location.hash !== href) {
            window.location.hash = href.slice(1);
        }
        setStatus('Moved to the next page.');
    }

    function asArray(value) {
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
            return Object.entries(value).map(([key, item]) => ({
                ...(item && typeof item === 'object' ? item : {}),
                __objectKey: key,
            }));
        }
        return [];
    }

    function normalizeRankName(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function loadCapturedRankOrder() {
        const saved = GM_getValue(SETTINGS.rankOrder, []);
        return Array.isArray(saved) ? saved.map(normalizeRankName).filter(Boolean) : [];
    }

    function sortFactionMembers(members) {
        const capturedOrder = loadCapturedRankOrder();
        const rankIndex = new Map(capturedOrder.map((rank, index) => [rank.toLowerCase(), index]));

        return [...members].sort((a, b) => {
            const aRank = normalizeRankName(a.rank) || 'Member';
            const bRank = normalizeRankName(b.rank) || 'Member';
            const aCaptured = rankIndex.get(aRank.toLowerCase());
            const bCaptured = rankIndex.get(bRank.toLowerCase());
            const aHasCaptured = Number.isInteger(aCaptured);
            const bHasCaptured = Number.isInteger(bCaptured);

            if (aHasCaptured && bHasCaptured && aCaptured !== bCaptured) return aCaptured - bCaptured;
            if (aHasCaptured !== bHasCaptured) return aHasCaptured ? -1 : 1;

            const rankCompare = aRank.localeCompare(bRank, undefined, { sensitivity: 'base', numeric: true });
            if (rankCompare) return rankCompare;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
        });
    }

    function parseFactionData(memberPayload) {
        const rawMembers = asArray(memberPayload?.members ?? memberPayload?.data?.members);
        const members = rawMembers.map((member) => {
            const id = member?.id ?? member?.user_id ?? member?.player_id ?? member?.__objectKey;
            if (id == null) return null;

            return {
                id: String(id),
                name: String(member?.name ?? id),
                level: Number(member?.level),
                rank: normalizeRankName(
                    member?.position?.name ??
                    member?.position_name ??
                    member?.position ??
                    member?.rank ??
                    'Member'
                ) || 'Member',
            };
        }).filter(Boolean);

        const unique = new Map(members.map((member) => [member.id, member]));
        return sortFactionMembers([...unique.values()]);
    }

    function rankPanelIsVisible() {
        const panel = document.querySelector('#faction-rank');
        if (!panel) return false;
        const style = getComputedStyle(panel);
        return panel.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && panel.getClientRects().length > 0;
    }

    function captureDisplayedRankOrder() {
        if (!pageIsFocused() || !rankPanelIsVisible() || !factionMembers.length) return false;
        const panel = document.querySelector('#faction-rank');
        const knownRanks = new Map();
        for (const member of factionMembers) {
            const rank = normalizeRankName(member.rank);
            if (rank) knownRanks.set(rank.toLowerCase(), rank);
        }
        if (knownRanks.size < 2) return false;

        const found = [];
        const seen = new Set();
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const text = normalizeRankName(node.nodeValue);
            const canonical = knownRanks.get(text.toLowerCase());
            if (!canonical || seen.has(canonical.toLowerCase())) continue;
            seen.add(canonical.toLowerCase());
            found.push(canonical);
        }

        if (found.length < 2) return false;
        const previous = loadCapturedRankOrder();
        if (JSON.stringify(previous) === JSON.stringify(found)) return true;

        GM_setValue(SETTINGS.rankOrder, found);
        factionMembers = sortFactionMembers(factionMembers);
        const cached = GM_getValue(SETTINGS.memberCache, null);
        if (cached && Array.isArray(cached.members)) {
            GM_setValue(SETTINGS.memberCache, {
                ...cached,
                members: sortFactionMembers(cached.members),
                rankOrderCapturedAt: Date.now(),
                source: 'v2 members + displayed Rank tab order',
            });
        }
        if (document.querySelector(`#${PANEL_ID} .car-whitelist-manager.show`)) renderWhitelistMembers();
        setStatus(`Captured displayed hierarchy for ${found.length} ranks.`, 'success');
        return true;
    }

    function scheduleRankOrderCapture() {
        [200, 600, 1200, 2400, 4000].forEach((delay) => {
            setTimeout(() => captureDisplayedRankOrder(), delay);
        });
    }

    function installRankOrderCapture() {
        document.addEventListener('click', (event) => {
            if (event.target.closest('[data-case="rank"], a[href="#faction-rank"]')) scheduleRankOrderCapture();
        }, true);

        const observer = new MutationObserver(() => {
            if (rankPanelIsVisible()) scheduleRankOrderCapture();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'aria-hidden'],
        });
    }

    function apiRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                headers: { 'Accept': 'application/json' },
                onload: (response) => {
                    try {
                        const payload = JSON.parse(response.responseText);
                        if (payload?.error) return reject(new Error(payload.error.error || 'Torn API returned an error.'));
                        resolve(payload);
                    } catch {
                        reject(new Error('Could not read the Torn API response.'));
                    }
                },
                ontimeout: () => reject(new Error('Torn API request timed out.')),
                onerror: () => reject(new Error('Torn API request failed.')),
            });
        });
    }

    async function requestFactionMembers(apiKey) {
        const key = encodeURIComponent(apiKey);
        return apiRequest(`https://api.torn.com/v2/faction/members?key=${key}`);
    }

    function applyMemberData(members) {
        factionMembers = sortFactionMembers(members);
        memberLevels = new Map(members.filter((m) => Number.isFinite(m.level)).map((m) => [m.id, m.level]));
    }

    async function ensureFactionMembers(force = false) {
        const cached = GM_getValue(SETTINGS.memberCache, null);
        const cacheIsFresh = cached?.savedAt && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS && Array.isArray(cached.members);

        // Even manual UI refreshes respect the 12-hour limit. Changing the API
        // key clears the cache and permits an immediate request with the new key.
        if (cacheIsFresh) {
            applyMemberData(cached.members);
            if (factionMembers.length) return true;
        }

        if (!pageIsFocused()) {
            setStatus('Faction data refresh paused until this page is focused.', 'error');
            return false;
        }
        const apiKey = String(GM_getValue(SETTINGS.apiKey, '')).trim();
        if (!apiKey) {
            setStatus('Enter an API key to load faction members.', 'error');
            document.querySelector(`#${PANEL_ID} .car-key-row`)?.classList.add('show');
            return false;
        }
        setStatus('Refreshing faction members…');
        try {
            const memberPayload = await requestFactionMembers(apiKey);
            const members = parseFactionData(memberPayload);
            if (!members.length) throw new Error('No faction members were returned by the API.');
            applyMemberData(members);
            GM_setValue(SETTINGS.memberCache, { savedAt: Date.now(), members, source: loadCapturedRankOrder().length ? 'v2 members + displayed Rank tab order' : 'v2 members + alphabetical ranks' });
            return true;
        } catch (error) {
            setStatus(error?.message || 'Could not load faction members.', 'error');
            return false;
        }
    }

    function saveApiKey() {
        const input = document.querySelector(`#${PANEL_ID} .car-api-key`);
        const key = input?.value.trim() || '';
        GM_setValue(SETTINGS.apiKey, key);
        GM_setValue(SETTINGS.memberCache, null);
        factionMembers = [];
        memberLevels.clear();
        setStatus(key ? 'API key saved.' : 'API key cleared.', 'success');
    }

    function updateWhitelistCount() {
        const count = document.querySelector(`#${PANEL_ID} .car-whitelist-count`);
        if (count) count.textContent = String(whitelist.size);
    }

    function renderWhitelistMembers() {
        const list = document.querySelector(`#${PANEL_ID} .car-member-list`);
        const search = (document.querySelector(`#${PANEL_ID} .car-member-search`)?.value || '').trim().toLowerCase();
        if (!list) return;
        const filtered = factionMembers.filter((member) => `${member.name} ${member.rank} ${member.id}`.toLowerCase().includes(search));
        list.replaceChildren();
        for (const member of filtered) {
            const label = document.createElement('label');
            label.className = 'car-member-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = whitelist.has(member.id);
            checkbox.dataset.memberId = member.id;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) whitelist.add(member.id); else whitelist.delete(member.id);
                saveWhitelist();
            });
            const text = document.createElement('span');
            text.innerHTML = `<strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.rank)} · ID ${member.id}</small>`;
            label.append(checkbox, text);
            list.appendChild(label);
        }
        if (!filtered.length) list.textContent = factionMembers.length ? 'No matching members.' : 'Load faction members to choose who should be skipped.';
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
    }

    async function openWhitelistManager() {
        const manager = document.querySelector(`#${PANEL_ID} .car-whitelist-manager`);
        manager?.classList.toggle('show');
        if (!manager?.classList.contains('show')) return;
        if (await ensureFactionMembers()) {
            renderWhitelistMembers();
            setStatus(`Loaded ${factionMembers.length} faction members.`, 'success');
        }
    }

    function setShownMembers(checked) {
        document.querySelectorAll(`#${PANEL_ID} .car-member-list input[type="checkbox"]`).forEach((box) => {
            const id = box.dataset.memberId;
            box.checked = checked;
            if (checked) whitelist.add(id); else whitelist.delete(id);
        });
        saveWhitelist();
    }

    function clampPanel(left, top, panel) {
        const margin = 8;
        return {
            left: Math.min(Math.max(margin, left), Math.max(margin, innerWidth - panel.offsetWidth - margin)),
            top: Math.min(Math.max(margin, top), Math.max(margin, innerHeight - panel.offsetHeight - margin)),
        };
    }

    function makePanelDraggable(panel) {
        const handle = panel.querySelector('.car-header');
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('mousedown', (event) => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            handle.classList.add('dragging');
            event.preventDefault();
        });

        document.addEventListener('mousemove', (event) => {
            if (!dragging) return;
            const pos = clampPanel(event.clientX - offsetX, event.clientY - offsetY, panel);
            panel.style.left = `${pos.left}px`;
            panel.style.top = `${pos.top}px`;
            panel.style.right = 'auto';
        }, true);

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            const rect = panel.getBoundingClientRect();
            const pos = clampPanel(rect.left, rect.top, panel);
            GM_setValue(SETTINGS.panelPosition, pos);
        }, true);
    }

    function applySavedPosition(panel) {
        const saved = GM_getValue(SETTINGS.panelPosition, null);
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
        const pos = clampPanel(saved.left, saved.top, panel);
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
        panel.style.right = 'auto';
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;
        const panel = document.createElement('section');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="car-header">
                <span>Armory RecCaller</span>
                <button type="button" class="car-minimize" title="Minimize">−</button>
            </div>
            <div class="car-body">
                <label class="car-label">Mode
                    <select class="car-mode">
                        <option value="${MODES.RANKED_ALL}">Ranked gear</option>
                        <option value="${MODES.RANKED_NO_PROF}">Ranked, skip Proficience</option>
                        <option value="${MODES.PROFICIENCE_15_PLUS}">Proficience only, level 15+</option>
                    </select>
                </label>
                <div class="car-actions">
                    <button type="button" class="car-retrieve">Retrieve Next</button>
                    <button type="button" class="car-next">Next Page</button>
                </div>
                <button type="button" class="car-whitelist-toggle">Whitelist (<span class="car-whitelist-count">0</span>)</button>
                <div class="car-whitelist-manager">
                    <div class="car-manager-title">Never retrieve from:</div>
                    <input class="car-member-search" type="search" placeholder="Search name, rank, or ID">
                    <div class="car-manager-actions">
                        <button type="button" class="car-load-members">Refresh if due</button>
                        <button type="button" class="car-select-shown">Select shown</button>
                        <button type="button" class="car-clear-shown">Clear shown</button>
                    </div>
                    <div class="car-member-list">Load faction members to choose who should be skipped.</div>
                </div>
                <button type="button" class="car-key-toggle">API Key</button>
                <div class="car-key-row">
                    <input class="car-api-key" type="password" autocomplete="off" placeholder="Limited Torn API key">
                    <button type="button" class="car-key-save">Save</button>
                </div>
                <div class="car-status" data-state="normal">Ready.</div>
            </div>`;

        const style = document.createElement('style');
        style.textContent = `
            #${PANEL_ID}{position:fixed;top:110px;right:12px;z-index:999999;width:270px;box-sizing:border-box;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:#202225;color:#eee;box-shadow:0 3px 12px rgba(0,0,0,.45);font:12px Arial,sans-serif;overflow:hidden}
            #${PANEL_ID} .car-header{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;font-size:14px;font-weight:700;cursor:move;cursor:grab;user-select:none;background:rgba(255,255,255,.05)}
            #${PANEL_ID} .car-header.dragging{cursor:grabbing}
            #${PANEL_ID} .car-header button{width:25px;padding:2px;cursor:pointer}
            #${PANEL_ID} .car-body{padding:10px}
            #${PANEL_ID}.minimized{width:auto}
            #${PANEL_ID}.minimized .car-body{display:none}
            #${PANEL_ID} button,#${PANEL_ID} input,#${PANEL_ID} select{box-sizing:border-box;font:inherit}
            #${PANEL_ID} button{padding:7px 5px;border:1px solid #555;border-radius:4px;background:#3a3d42;color:#fff;cursor:pointer}
            #${PANEL_ID} button:hover{background:#4a4e54}
            #${PANEL_ID} .car-label{display:block;font-weight:700}
            #${PANEL_ID} select,#${PANEL_ID} input{width:100%;margin-top:4px;padding:6px;border:1px solid #555;border-radius:4px;background:#111;color:#eee}
            #${PANEL_ID} .car-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
            #${PANEL_ID} .car-whitelist-toggle{width:100%;margin-top:7px}
            #${PANEL_ID} .car-whitelist-manager{display:none;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12)}
            #${PANEL_ID} .car-whitelist-manager.show{display:block}
            #${PANEL_ID} .car-manager-title{font-weight:700;margin-bottom:4px}
            #${PANEL_ID} .car-manager-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:6px 0}
            #${PANEL_ID} .car-manager-actions button{padding:5px 2px;font-size:11px}
            #${PANEL_ID} .car-member-list{max-height:260px;overflow-y:auto;border:1px solid #444;border-radius:4px;background:#17191b}
            #${PANEL_ID} .car-member-row{display:flex;gap:7px;align-items:flex-start;padding:6px;border-bottom:1px solid #333;cursor:pointer}
            #${PANEL_ID} .car-member-row:last-child{border-bottom:0}
            #${PANEL_ID} .car-member-row:hover{background:rgba(255,255,255,.05)}
            #${PANEL_ID} .car-member-row input{width:auto;margin:2px 0 0}
            #${PANEL_ID} .car-member-row span{display:flex;flex-direction:column;min-width:0}
            #${PANEL_ID} .car-member-row small{color:#aaa;margin-top:2px}
            #${PANEL_ID} .car-key-toggle{margin-top:7px;padding:3px 6px;font-size:11px}
            #${PANEL_ID} .car-key-row{display:none;grid-template-columns:1fr 48px;gap:5px;margin-top:6px}
            #${PANEL_ID} .car-key-row.show{display:grid}
            #${PANEL_ID} .car-status{margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12);line-height:1.3}
            #${PANEL_ID} .car-status[data-state="success"]{color:#8ee28e}
            #${PANEL_ID} .car-status[data-state="error"]{color:#ff9696}
            #${PANEL_ID} .car-status[data-state="done"]{color:#ffd37a}`;

        document.head.appendChild(style);
        document.body.appendChild(panel);
        applySavedPosition(panel);
        makePanelDraggable(panel);

        const mode = panel.querySelector('.car-mode');
        mode.value = GM_getValue(SETTINGS.mode, MODES.RANKED_ALL);
        mode.addEventListener('change', () => { GM_setValue(SETTINGS.mode, mode.value); setStatus('Mode saved.'); });
        panel.querySelector('.car-retrieve').addEventListener('click', handleRetrieveClick);
        panel.querySelector('.car-next').addEventListener('click', handleNextPageClick);
        panel.querySelector('.car-whitelist-toggle').addEventListener('click', openWhitelistManager);
        panel.querySelector('.car-member-search').addEventListener('input', renderWhitelistMembers);
        panel.querySelector('.car-load-members').addEventListener('click', async () => { if (await ensureFactionMembers(false)) { renderWhitelistMembers(); const cached = GM_getValue(SETTINGS.memberCache, null); const age = cached?.savedAt ? Math.max(0, Date.now() - cached.savedAt) : 0; const hours = Math.floor(age / 3600000); setStatus(`Using faction data cached ${hours}h ago.`, 'success'); } });
        panel.querySelector('.car-select-shown').addEventListener('click', () => setShownMembers(true));
        panel.querySelector('.car-clear-shown').addEventListener('click', () => setShownMembers(false));
        panel.querySelector('.car-key-toggle').addEventListener('click', () => panel.querySelector('.car-key-row').classList.toggle('show'));
        panel.querySelector('.car-key-save').addEventListener('click', saveApiKey);
        panel.querySelector('.car-api-key').value = GM_getValue(SETTINGS.apiKey, '');
        panel.querySelector('.car-minimize').addEventListener('click', (event) => {
            event.stopPropagation();
            panel.classList.toggle('minimized');
            const minimized = panel.classList.contains('minimized');
            panel.querySelector('.car-minimize').textContent = minimized ? '+' : '−';
            GM_setValue(SETTINGS.minimized, minimized);
        });
        if (GM_getValue(SETTINGS.minimized, false)) {
            panel.classList.add('minimized');
            panel.querySelector('.car-minimize').textContent = '+';
        }
        updateWhitelistCount();
    }

    function boot() {
        if (document.body) createPanel();
    }

    boot();
    installRankOrderCapture();
    new MutationObserver(() => { if (!document.getElementById(PANEL_ID)) createPanel(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
