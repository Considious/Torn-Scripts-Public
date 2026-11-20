// ==UserScript==
// @name        Torn Profile Link Formatter
// @namespace   GNSC4 [268863]
// @version     1.6.29
// @downloadURL https://raw.githubusercontent.com/Considious/Torn-Scripts-Public/main/Torn-Profile-Link-Formatter.user.js
// @updateURL   https://raw.githubusercontent.com/Considious/Torn-Scripts-Public/main/Torn-Profile-Link-Formatter.user.js
// @description Formatted profile links, FFScouter fallback, and two-click faction chat sharing for members and incoming chain attacks.
// @author      GNS-C4 [3960752]
// @contributor Considious [3853023]
// @match       https://www.torn.com/profiles.php?XID=*
// @match       https://www.torn.com/factions.php*
// @grant       GM_addStyle
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // --- Global cache for live hospital data ---
    let hospTime = {};
    const debug = false; // Set to true for verbose logging

    // --- Time Constants ---
    const SIX_MONTHS_SECONDS = 15552000; // 6 months in seconds (approx 180 days)

    // --- GM Polyfills for environments without native support ---
    const GNSC_setValue = typeof GM_setValue !== 'undefined' ? GM_setValue : (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const GNSC_getValue = typeof GM_getValue !== 'undefined' ? GM_getValue : (key, def) => JSON.parse(localStorage.getItem(key)) || def;

    // --- Add Styles for the UI ---
    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(`
            .gnsc-copy-container { display: inline-flex; align-items: center; vertical-align: middle; gap: 5px; margin-left: 10px; }
            .gnsc-btn { background-color: #333; color: #DDD; border: 1px solid #555; border-radius: 5px; padding: 3px 8px; text-decoration: none; font-size: 12px; line-height: 1.5; font-weight: bold; cursor: pointer; white-space: nowrap; }
            .gnsc-btn:hover { background-color: #444; }
            .gnsc-list-btn { margin-left: 5px; cursor: pointer; font-size: 14px; display: inline-block; vertical-align: middle; width: 18px; text-align: center; }
            .gnsc-faction-copy-btn { margin-left: 8px; cursor: pointer; font-size: 14px; vertical-align: middle; }
            /* Enemy ranked-war rows only. Leave every Torn/other-plugin cell unchanged
               except for reserving the width of this one small native-style column
               from the enemy Members cell. */
            .enemy-faction .gnsc-link-cell { float: left; box-sizing: border-box;
                width: 28px; height: 30px; line-height: 30px; text-align: center;
                overflow: hidden; white-space: nowrap; }
            .enemy-faction .gnsc-link-header { font: inherit; line-height: inherit; }
            .enemy-faction .gnsc-chat-send-btn { display: inline-block;
                background: transparent; border: 0; margin: 0; padding: 0;
                width: 27px; height: 29px; color: inherit; font: inherit;
                font-size: 18px; line-height: 29px; cursor: pointer; vertical-align: middle; }
            .enemy-faction .gnsc-chat-send-btn.gnsc-armed { background: #2b6237; color: white; }
            .enemy-faction .gnsc-chat-send-btn:disabled { opacity: .7; cursor: wait; }
            .gnsc-chain-action { display: inline-flex; vertical-align: middle; margin-left: 6px; }
            .gnsc-chain-action .gnsc-chat-send-btn { width: 30px; min-height: 27px; background: #30373b;
                color: #eee; border: 1px solid #69717b; border-radius: 5px; cursor: pointer; }
            .gnsc-list-btn { vertical-align: middle; }

            .gnsc-settings-panel { display: none; position: absolute; background-color: #2c2c2c; border: 1px solid #555; border-radius: 5px; padding: 10px; z-index: 1000; top: 100%; left: 0; min-width: 220px; }
            .gnsc-settings-panel div { margin-bottom: 5px; display: flex; align-items: center; }
            .gnsc-settings-panel label { color: #DDD; flex-grow: 1; }
            .gnsc-settings-panel input[type="checkbox"] { margin-left: 5px; }
            .gnsc-settings-panel label.disabled { color: #888; }
            .gnsc-settings-container { position: relative; }
            .gnsc-api-key-wrapper { display: flex; flex-direction: column; align-items: flex-start !important; }
            .gnsc-api-key-wrapper label { margin-bottom: 4px; }
            .gnsc-api-key-input-wrapper { display: flex; width: 100%; }
            .gnsc-api-key-input { width: 100%; background-color: #1e1e1e; border: 1px solid #555; color: #ddd; border-radius: 3px; padding: 2px 4px;}
            #gnsc-show-api-key-btn, #gnsc-show-ff-api-key-btn { font-size: 10px; margin-left: 4px; padding: 2px 4px; }
            .buttons-list .gnsc-list-btn { padding: 4px; font-size: 16px; height: 34px; line-height: 26px; } /* Mini profile button style */
            #gnsc-battlestats-format-wrapper { flex-direction: column; align-items: flex-start; margin-top: 8px; }
            #gnsc-battlestats-format-wrapper label { margin-bottom: 4px; }
            #gnsc-select-battlestats-format { background-color: #1e1e1e; border: 1px solid #555; color: #ddd; border-radius: 3px; padding: 2px 4px; width: 100%; }
        `);
    }

    // --- Page Initialization Logic ---

    function initProfilePage() {
        const nameElement = document.querySelector('#skip-to-content');
        const infoTable = document.querySelector('.basic-information .info-table');
        const alreadyInjected = document.querySelector('.gnsc-copy-container');
        if (nameElement && infoTable && infoTable.children.length > 5 && !alreadyInjected) {
            mainProfile(nameElement, infoTable);
            return true;
        }
        return false;
    }

    function initFactionPage() {
        // The friendly faction is deliberately never queried or modified.
        const list = document.querySelector('.enemy-faction ul.members-list');
        if (!list) return false;
        injectButtonsIntoList(list);
        return true;
    }
function initChainPage() {
    const isChainPage =
        window.location.hash.toLowerCase().includes("chain") ||
        window.location.href.toLowerCase().includes("chain");

    if (!isChainPage) {
        return false;
    }

    const rows = document.querySelectorAll("li");
    let injected = false;

    rows.forEach(row => {
        /*
         * Incoming attacks use the red enemy arrow:
         * <i class="chain-arrow-icon enemy"></i>
         *
         * Outgoing attacks use a different arrow and are ignored.
         */
        const incomingArrow = row.querySelector(
            ".arrow .chain-arrow-icon.enemy"
        );

        if (!incomingArrow) {
            return;
        }

        /*
         * The attacker is the player displayed on the right side
         * of an incoming attack row.
         */
        const enemyPlayer = row.querySelector(
            ".player.right-player"
        );

        if (!enemyPlayer) {
            return;
        }

        const nameLink = enemyPlayer.querySelector(
            'a[href*="profiles.php?XID="]'
        );

        if (!nameLink) {
            return;
        }

        if (
            nameLink.dataset.gnscChainInjected === "true"
        ) {
            return;
        }

        const idMatch = nameLink.href.match(
            /XID=(\d+)/
        );

        if (!idMatch) {
            return;
        }

        nameLink.dataset.gnscChainInjected = "true";

        const column = document.createElement('div');
        column.className = 'gnsc-action-column';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gnsc-chat-send-btn';
        button.textContent = '📄';
        button.title = 'Prepare retaliation in faction chat; click again to send. Shift-click to copy.';
        button.addEventListener('click', event => {
            handleFactionMemberChatClick(event, button, enemyPlayer, true);
        });
        column.appendChild(button);
        // Chain log rows are not ranked-war table rows: retain inline placement.
        column.classList.add('gnsc-chain-action');
        enemyPlayer.appendChild(column);

        injected = true;
    });

    return injected;
}

    function initRankedWarPage() {
        const factionNames = document.querySelectorAll('.faction-names .name___PlMCO');
        factionNames.forEach(nameDiv => {
            if (!nameDiv.querySelector('.gnsc-faction-copy-btn')) {
                const button = document.createElement('span');
                button.className = 'gnsc-faction-copy-btn';
                button.textContent = '📋';
                button.title = 'Copy Faction Member List';
                button.addEventListener('click', (e) => handleFactionCopyClick(e, button, nameDiv.classList.contains('left')));
                (nameDiv.querySelector('.text___chra_') || nameDiv).appendChild(button);
            }
        });
    }

    function initMiniProfile() {
        const miniProfile = document.querySelector('.profile-mini-_wrapper___Arw8R:not(.gnsc-injected), .mini-profile-wrapper:not(.gnsc-injected)');
        if (miniProfile) {
            miniProfile.classList.add('gnsc-injected');
            let attempts = 0;
            const maxAttempts = 25; // Try for 5 seconds
            const interval = setInterval(() => {
                const buttonContainer = miniProfile.querySelector('.buttons-list');
                const nameLink = miniProfile.querySelector('a[href*="profiles.php?XID="]');
                if (buttonContainer && nameLink && !buttonContainer.querySelector('.gnsc-list-btn')) {
                    clearInterval(interval);
                    const button = document.createElement('span');
                    button.className = 'gnsc-list-btn';
                    button.textContent = '📄';
                    button.title = 'Copy Formatted Link';
                    button.addEventListener('click', (e) => handleListCopyClick(e, button, miniProfile));
                    buttonContainer.insertAdjacentElement('beforeend', button);
                } else if (attempts >= maxAttempts) {
                    clearInterval(interval);
                }
                attempts++;
            }, 200);
        }
    }

    // Two separate physical clicks: prepare chat draft, then explicitly send.
    // No timers, observer callbacks, or network calls trigger the send action.
    const pendingFactionMessages = new WeakMap();
    function factionChatControls() {
        // Only the user's currently visible FACTION chat, never a private message panel.
        const chat = document.querySelector('#faction');
        if (!chat || !chat.getClientRects().length) return null;
        const textarea = chat.querySelector('textarea');
        const send = textarea?.parentElement?.querySelector('button:not([data-prevent-flyout-swipe])')
            || chat.querySelector('button[class*="iconWrapper"]');
        return textarea && send ? { textarea, send } : null;
    }
    function setReactTextarea(textarea, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return false;
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }
    function notifyFactionButton(button, label, tooltip, ms = 2500) {
        button.textContent = label;
        button.title = tooltip;
        if (ms) setTimeout(() => {
            if (!pendingFactionMessages.has(button)) {
                button.textContent = '📄';
                button.title = 'Click to prepare faction chat; click again to send. Shift-click to copy.';
            }
        }, ms);
    }
    async function handleFactionMemberChatClick(event, button, member, isChain = false) {
        event.preventDefault();
        event.stopPropagation();
        if (!document.hasFocus() || document.visibilityState !== 'visible') return;
        if (button.disabled) return;

        if (event.shiftKey) {
            pendingFactionMessages.delete(button);
            button.classList.remove('gnsc-armed');
            return handleListCopyClick(event, button, member, isChain);
        }
        const active = pendingFactionMessages.get(button);
        if (active) {
            const chat = factionChatControls();
            // Do not overwrite or send a different message composed in the meantime.
            if (!chat || chat.textarea.value !== active.text) {
                pendingFactionMessages.delete(button);
                button.classList.remove('gnsc-armed');
                notifyFactionButton(button, '⚠', 'Draft changed or faction chat closed. Click again to prepare.');
                return;
            }
            if (chat.send.disabled) {
                notifyFactionButton(button, '…', 'Chat is not ready to send. Click again when ready.', 0);
                return;
            }
            // Exactly one native send-button activation, directly from this second click.
            pendingFactionMessages.delete(button);
            button.classList.remove('gnsc-armed');
            chat.send.click();
            notifyFactionButton(button, '✅', 'Send requested using the faction chat send button.');
            return;
        }

        const chat = factionChatControls();
        if (!chat) {
            notifyFactionButton(button, '⚠', 'Open faction chat first, then click again.');
            return;
        }
        if (chat.textarea.value.trim()) {
            notifyFactionButton(button, '⚠', 'Faction chat already has a draft. Clear or send it first.');
            return;
        }
        button.disabled = true;
        button.textContent = '…';
        try {
            const text = await buildListMessage(member, isChain);
            if (!text) throw Error('Could not find the player profile link.');
            if (!document.hasFocus() || document.visibilityState !== 'visible') return;
            const current = factionChatControls();
            if (!current || current.textarea.value.trim()) throw Error('Faction chat is not available or already has a draft.');
            if (!setReactTextarea(current.textarea, text)) throw Error('Could not prepare the chat input.');
            pendingFactionMessages.set(button, { text });
            button.classList.add('gnsc-armed');
            button.textContent = '➤';
            button.title = 'Click again to SEND this message to faction chat. Shift-click to copy instead.';
        } catch (err) {
            notifyFactionButton(button, '⚠', err.message || 'Unable to prepare faction chat.');
        } finally { button.disabled = false; }
    }

    // Only the ENEMY side receives the Link column. Retain other addons' inline
    // width expressions; for cells with CSS-defined widths, use one batched
    // measurement pass before any row is changed (never interleave reads/writes).
    const WAR_LINK_PX = 28;
    const processedEnemyRows = new WeakSet();
    function addWarLinkCell(row, header = false, fallbackWidth = 0) {
        if (processedEnemyRows.has(row)) return;
        if (row.querySelector(':scope > .gnsc-link-cell')) {
            processedEnemyRows.add(row);
            return;
        }
        if (!row.closest('.enemy-faction')) return;
        const memberCell = row.querySelector(':scope > .member');
        const attackCell = row.querySelector(':scope > .attack');
        const clear = row.querySelector(':scope > .clear');
        if (!memberCell || !attackCell || !clear) return;
        if (!header && !row.matches('li.enemy')) return;
        if (!header && !memberCell.querySelector('a[href*="profiles.php?XID="]')) return;

        // Some Torn/FFScouter combinations define width only in stylesheets.
        // Use the previously batched measurement for those rows instead of
        // silently skipping every Link button.
        const inlineWidth = memberCell.style.getPropertyValue('width').trim();
        const startingWidth = inlineWidth || (fallbackWidth >= 125 ? `${fallbackWidth}px` : '');
        if (!startingWidth) return;

        const cell = document.createElement('div');
        cell.className = 'gnsc-link-cell left' + (header ? ' gnsc-link-header' : '');
        if (header) {
            cell.textContent = 'Link';
        } else {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'gnsc-chat-send-btn';
            button.textContent = '📄';
            button.title = 'Click to prepare faction chat; click again to send. Shift-click to copy.';
            button.addEventListener('click', event => handleFactionMemberChatClick(event, button, row));
            cell.appendChild(button);
        }
        // Preserve a prior width *expression* instead of flattening its
        // percentage/calc into pixels. Only touch the enemy Members cell.
        memberCell.style.setProperty('width', `calc(${startingWidth} - ${WAR_LINK_PX}px)`, 'important');
        clear.before(cell);
        processedEnemyRows.add(row);
    }

    function injectButtonsIntoList(listElement) {
        if (!listElement?.matches('ul.members-list') || !listElement.closest('.enemy-faction')) return;
        const header = listElement.previousElementSibling;
        if (header?.matches('.white-grad')) addWarLinkCell(header, true);
        for (const row of listElement.querySelectorAll(':scope > li.enemy')) addWarLinkCell(row);
    }

    // --- Profile Page Specific Functions ---

    function mainProfile(nameElement, infoTable) {
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('XID');
        if (!userId) return;

        const cleanedName = nameElement.textContent.replace("'s Profile", "").split(' [')[0].trim();
        let factionLinkEl = null;
        let companyLinkEl = null;
        let activityStatus = 'Offline';

        const infoListItems = infoTable.querySelectorAll('li');
        infoListItems.forEach(item => {
            const titleEl = item.querySelector('.user-information-section .bold');
            if (!titleEl) return;
            const title = titleEl.textContent.trim();
            if (title === 'Faction') factionLinkEl = item.querySelector('.user-info-value a');
            if (title === 'Job') companyLinkEl = item.querySelector('.user-info-value a');
        });

        const statusIconEl = document.querySelector('li[id^="icon1-profile-"], li[id^="icon2-profile-"], li[id^="icon62-profile-"]');
        if (statusIconEl) {
            if (statusIconEl.className.includes('-Online')) activityStatus = 'Online';
            else if (statusIconEl.className.includes('-Away')) activityStatus = 'Idle';
        }

        const statusDescEl = document.querySelector('.profile-status.hospital .main-desc');
        const isInHospital = !!statusDescEl;
        const hospitalTimeStr = isInHospital ? statusDescEl.textContent.trim().replace(/\s+/g, ' ') : null;

        const userInfo = {
            id: userId,
            name: cleanedName,
            profileUrl: `https://www.torn.com/profiles.php?XID=${userId}`,
            attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${userId}`,
            factionUrl: factionLinkEl ? factionLinkEl.href : null,
            companyUrl: companyLinkEl ? companyLinkEl.href : null,
            activityStatus: activityStatus,
            isInHospital: isInHospital,
            hospitalTimeStr: hospitalTimeStr
        };

        createUI(nameElement, userInfo);
    }

    function createUI(targetElement, userInfo) {
        const container = document.createElement('div');
        container.className = 'gnsc-copy-container';

        const copyButton = document.createElement('a');
        copyButton.href = "#";
        copyButton.className = 'gnsc-btn';
        copyButton.innerHTML = '<span>Copy</span>';
        copyButton.addEventListener('click', (e) => handleCopyClick(e, copyButton, userInfo));

        const settingsContainer = document.createElement('div');
        settingsContainer.className = 'gnsc-settings-container';

        const settingsButton = document.createElement('a');
        settingsButton.href = "#";
        settingsButton.className = 'gnsc-btn';
        settingsButton.innerHTML = '⚙️';

        const settingsPanel = createSettingsPanel(userInfo);
        settingsButton.addEventListener('click', (e) => {
            e.preventDefault();
            settingsPanel.style.display = settingsPanel.style.display === 'block' ? 'none' : 'block';
        });

        document.addEventListener('click', (e) => {
            if (!settingsContainer.contains(e.target)) {
                settingsPanel.style.display = 'none';
            }
        });

        settingsContainer.appendChild(settingsButton);
        settingsContainer.appendChild(settingsPanel);
        container.appendChild(copyButton);
        container.appendChild(settingsContainer);
        targetElement.insertAdjacentElement('afterend', container);
    }

    function createSettingsPanel(userInfo) {
        const panel = document.createElement('div');
        panel.className = 'gnsc-settings-panel';
        const settings = loadSettings();

        // TornStats Key
        const apiKeyWrapper = document.createElement('div');
        apiKeyWrapper.className = 'gnsc-api-key-wrapper';
        apiKeyWrapper.innerHTML = `<label for="gnsc-api-key">TornStats API Key</label>`;
        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'gnsc-api-key-input-wrapper';

        const apiKeyInput = document.createElement('input');
        apiKeyInput.type = 'password';
        apiKeyInput.id = 'gnsc-api-key';
        apiKeyInput.className = 'gnsc-api-key-input';
        apiKeyInput.value = settings.apiKey || '';
        apiKeyInput.addEventListener('input', () => {
            updateBattleStatsAvailability();
            saveSettings();
        });

        const showApiKeyBtn = document.createElement('button');
        showApiKeyBtn.id = 'gnsc-show-api-key-btn';
        showApiKeyBtn.className = 'gnsc-btn';
        showApiKeyBtn.textContent = 'Show';
        showApiKeyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
            showApiKeyBtn.textContent = apiKeyInput.type === 'password' ? 'Show' : 'Hide';
        });

        inputWrapper.appendChild(apiKeyInput);
        inputWrapper.appendChild(showApiKeyBtn);
        apiKeyWrapper.appendChild(inputWrapper);
        panel.appendChild(apiKeyWrapper);

        // FFScouter Key
        const ffApiKeyWrapper = document.createElement('div');
        ffApiKeyWrapper.className = 'gnsc-api-key-wrapper';
        ffApiKeyWrapper.innerHTML = `<label for="gnsc-ff-api-key" style="margin-top: 6px;">FFScouter API Key</label>`;
        const ffInputWrapper = document.createElement('div');
        ffInputWrapper.className = 'gnsc-api-key-input-wrapper';

        const ffApiKeyInput = document.createElement('input');
        ffApiKeyInput.type = 'password';
        ffApiKeyInput.id = 'gnsc-ff-api-key';
        ffApiKeyInput.className = 'gnsc-api-key-input';
        ffApiKeyInput.value = settings.ffApiKey || '';
        ffApiKeyInput.addEventListener('input', () => {
            updateBattleStatsAvailability();
            saveSettings();
        });

        const showFfApiKeyBtn = document.createElement('button');
        showFfApiKeyBtn.id = 'gnsc-show-ff-api-key-btn';
        showFfApiKeyBtn.className = 'gnsc-btn';
        showFfApiKeyBtn.textContent = 'Show';
        showFfApiKeyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            ffApiKeyInput.type = ffApiKeyInput.type === 'password' ? 'text' : 'password';
            showFfApiKeyBtn.textContent = ffApiKeyInput.type === 'password' ? 'Show' : 'Hide';
        });

        ffInputWrapper.appendChild(ffApiKeyInput);
        ffInputWrapper.appendChild(showFfApiKeyBtn);
        ffApiKeyWrapper.appendChild(ffInputWrapper);
        panel.appendChild(ffApiKeyWrapper);

        panel.appendChild(document.createElement('hr'));

        const options = [
            { key: 'attack', label: 'Attack', available: true },
            { key: 'activity', label: 'Activity Status', available: true },
            { key: 'faction', label: 'Faction', available: !!userInfo.factionUrl },
            { key: 'company', label: 'Company', available: !!userInfo.companyUrl },
            { key: 'timeRemaining', label: 'Time Remaining', available: userInfo.isInHospital },
            { key: 'releaseTime', label: 'Release Time (TCT)', available: userInfo.isInHospital },
            { key: 'battlestats', label: 'Battle Stats (TornStats)', available: true },
            { key: 'ffscouter', label: 'Enable FFScouter Fallback', available: true }
        ];

        options.forEach(option => {
            const wrapper = document.createElement('div');
            const checkbox = document.createElement('input');
            const label = document.createElement('label');

            checkbox.type = 'checkbox';
            checkbox.id = `gnsc-check-${option.key}`;
            checkbox.checked = option.available && settings[option.key];
            checkbox.disabled = !option.available;
            checkbox.addEventListener('change', () => {
                if (option.key === 'battlestats' || option.key === 'ffscouter') {
                    updateBattleStatsAvailability();
                }
                saveSettings();
            });

            label.htmlFor = `gnsc-check-${option.key}`;
            label.textContent = option.label;
            if (!option.available) label.classList.add('disabled');

            wrapper.appendChild(label);
            wrapper.appendChild(checkbox);
            panel.appendChild(wrapper);
        });

        const formatWrapper = document.createElement('div');
        formatWrapper.id = 'gnsc-battlestats-format-wrapper';
        formatWrapper.style.display = 'none'; // Initially hidden

        const formatLabel = document.createElement('label');
        formatLabel.htmlFor = 'gnsc-select-battlestats-format';
        formatLabel.textContent = 'Stat Display Format';

        const formatSelect = document.createElement('select');
        formatSelect.id = 'gnsc-select-battlestats-format';
        formatSelect.innerHTML = `
            <option value="all">All Stats</option>
            <option value="highest">Highest Stat & Total</option>
            <option value="total">Total Only</option>
        `;
        formatSelect.value = settings.battleStatsFormat;
        formatSelect.addEventListener('change', saveSettings);

        formatWrapper.appendChild(formatLabel);
        formatWrapper.appendChild(formatSelect);
        panel.appendChild(formatWrapper);

        updateBattleStatsAvailability();
        return panel;
    }

    // --- Copy output: simple Markdown links with no nested square brackets. ---
    function cleanPlayerName(value) {
        let name = String(value || '').trim();
        name = name.replace(/<[^>]*>/g, '');
        // Player name text may be decorated by other scripts with numeric IDs,
        // FFScouter ratios, or pasted Markdown. Keep only the actual name.
        name = name.replace(/^\[([^\]]+)\]\([^)]*\).*$/, '$1');
        name = name.split(/\s*\[\d+\]|\s*\[\d+(?:\.\d+)?\]\(|\s*\([^)]*FFScouter/i)[0];
        return name.replace(/\[[^\]]*$/, '').trim() || 'Unknown';
    }

    function markdownLink(label, url) {
        // Link labels never contain a nested bracketed player ID. This avoids
        // double-escaped Markdown in Discord and rich-text paste targets.
        const safeLabel = String(label).replace(/[\[\]\\]/g, '').trim();
        return `[${safeLabel}](${url})`;
    }

    function playerMarkdownLink(name, id) {
        const numericId = String(id);
        return `${markdownLink(cleanPlayerName(name), `https://www.torn.com/profiles.php?XID=${numericId}`)} [${numericId}]`;
    }

    // --- Core Logic & Action Handlers ---

    // Cache only successful/recent formatted lookups. A second click or another
    // request for the same player reuses the in-flight request; no polling.
    const recentStats = new Map();
    const STATS_CACHE_MS = 30_000;
    async function getCombinedStatsString(userId, settings) {
        const cacheKey = JSON.stringify([String(userId), settings.battlestats,
            settings.ffscouter, settings.apiKey, settings.ffApiKey, settings.battleStatsFormat]);
        const hit = recentStats.get(cacheKey);
        if (hit && (hit.pending || Date.now() - hit.at < STATS_CACHE_MS)) return hit.value;
        const pending = (async () => {
            // Start both independent lookups together. FFScouter's result is
            // *used* only if the TornStats spy is absent or at least 6 months old.
            const tsPromise = settings.battlestats && settings.apiKey
                ? fetchTornStatsSpy(settings.apiKey, userId, true).catch(error => {
                    if (debug) console.error('[GNSC-Debug] TS Error', error);
                    return null;
                }) : Promise.resolve(null);
            const ffPromise = settings.ffscouter && settings.ffApiKey
                ? fetchFFScouterSpy(settings.ffApiKey, userId, true).catch(error => {
                    if (debug) console.error('[GNSC-Debug] FF Error', error);
                    return null;
                }) : Promise.resolve(null);
            const tsData = await tsPromise;
            const spy = tsData?.spy?.status === true ? tsData.spy : null;
            const age = spy?.timestamp ? Math.floor(Date.now() / 1000) - spy.timestamp : Infinity;
            if (age < SIX_MONTHS_SECONDS) {
                return formatBattleStatsString(spy, settings.battleStatsFormat);
            }
            const ffData = await ffPromise;
            const ffRecord = Array.isArray(ffData) ? ffData.find(r => String(r.player_id) === String(userId)) : null;
            if (ffRecord) return formatFFScouterString(ffRecord);
            return spy ? formatBattleStatsString(spy, settings.battleStatsFormat) : '(Stats: N/A)';
        })();
        recentStats.set(cacheKey, { pending: true, value: pending, at: Date.now() });
        try {
            const result = await pending;
            recentStats.set(cacheKey, { pending: false, value: result, at: Date.now() });
            // Keep the tiny cache bounded even when browsing lots of players.
            if (recentStats.size > 100) recentStats.delete(recentStats.keys().next().value);
            return result;
        } catch (error) {
            recentStats.delete(cacheKey);
            throw error;
        }
    }

    function formatHospitalDuration(seconds) {
        const value = Math.max(0, Math.ceil(seconds));
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor(value % 3600 / 60);
        const secs = value % 60;
        const parts = [];
        if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
        if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
        if (secs || !parts.length) parts.push(`${secs} ${secs === 1 ? 'second' : 'seconds'}`);
        return parts.join(' ');
    }

    // Read Torn's currently rendered status, not spy age or stale cached status.
    // A war row has a native status cell and a data-until Unix release time.
    function formatHospitalStatus(releaseSeconds, settings) {
        const remaining = Math.ceil(releaseSeconds - Date.now() / 1000);
        if (remaining <= 0) return 'Hospital (release time passed; awaiting status update)';
        const parts = [];
        if (settings.timeRemaining) parts.push(`out in ${formatHospitalDuration(remaining)}`);
        if (settings.releaseTime) {
            const at = new Date(releaseSeconds * 1000).toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC'
            });
            parts.push(`at ${at} TCT`);
        }
        return parts.length ? `Hospital — ${parts.join(', ')}` : 'Hospital';
    }

    function memberCurrentStatus(memberElement, id, settings) {
        const row = memberElement.closest('li.enemy, li.your, li.table-row, li.member') || memberElement;
        const cell = row.querySelector(':scope > .status');
        if (!cell) return 'Status unknown';
        const rawStatus = (cell.textContent || '').trim().replace(/\s+/g, ' ');
        const hospital = /\bhospital\b/i.test(rawStatus) || cell.classList.contains('hospital');
        if (!hospital) {
            // A previous hospital timer is irrelevant once Torn shows another status.
            if (hospTime[id]) delete hospTime[id];
            return rawStatus ? `Status: ${rawStatus}` : 'Status unknown';
        }
        // Torn's data-until is populated for hospitalised war members.
        const fromRow = Number(row.getAttribute('data-until'));
        const fromCache = Number(hospTime[id]);
        const release = fromRow > 0 ? fromRow : fromCache > 0 ? fromCache : 0;
        return release ? formatHospitalStatus(release, settings) : 'Hospital (release time unavailable)';
    }

    async function handleCopyClick(e, button, userInfo) {
        e.preventDefault();
        if (debug) console.log(`[GNSC-Debug] handleCopyClick initiated for ID: ${userInfo.id}`);

        const settings = loadSettings();
        let battleStatsStr = null;
        let hospitalStr = null;
        let statusEmoji = '';

        if (settings.activity) {
            statusEmoji = userInfo.activityStatus === 'Online' ? '🟢 ' : (userInfo.activityStatus === 'Idle' ? '🟡 ' : '⚫ ');
        }

        const releaseTimestamp = Number(hospTime[userInfo.id]) || 0;
        if (userInfo.isInHospital) {
            hospitalStr = releaseTimestamp > 0
                ? formatHospitalStatus(releaseTimestamp, settings)
                : `Hospital${userInfo.hospitalTimeStr ? ` (${userInfo.hospitalTimeStr})` : ' (release time unavailable)'}`;
        } else {
            hospitalStr = 'Status: Okay';
        }

        // Stat Fetching Engine
        if (settings.battlestats || settings.ffscouter) {
            button.innerHTML = '<span>Fetching...</span>';
            battleStatsStr = await getCombinedStatsString(userInfo.id, settings);
        }

        const linkedName = playerMarkdownLink(userInfo.name, userInfo.id);
        const details = [];
        if (settings.attack) details.push(markdownLink('Attack', userInfo.attackUrl));
        if (settings.faction && userInfo.factionUrl) details.push(markdownLink('Faction', userInfo.factionUrl));
        if (settings.company && userInfo.companyUrl) details.push(markdownLink('Company', userInfo.companyUrl));
        if (hospitalStr) details.push(hospitalStr);
        if (battleStatsStr) details.push(battleStatsStr);

        const finalString = details.length > 0 ? `${statusEmoji}${linkedName} - ${details.join(' - ')}` : `${statusEmoji}${linkedName}`;
        if (debug) console.log(`[GNSC-Debug] Final string constructed. Sending to clipboard...`);

        copyToClipboard(finalString);

        button.innerHTML = '<span>Copied!</span>';
        button.style.backgroundColor = '#2a633a';
        setTimeout(() => { button.innerHTML = '<span>Copy</span>'; button.style.backgroundColor = ''; }, 2000);
    }

    async function buildListMessage(memberElement, isChain = false) {
        const nameLink = memberElement.querySelector('a[href*="profiles.php"]');
        if (!nameLink) return null;

        const name = [...nameLink.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim() || nameLink.textContent.trim();
        const idMatch = nameLink.href.match(/XID=(\d+)/);
        if (!idMatch) return null;
        const id = idMatch[1];



        const settings = loadSettings();
        let statusEmoji = '';
        let healthStr = null;
        let battleStatsStr = null;

        if (settings.activity) {
            // Torn's current status is exposed on the wrapper's aria-label,
            // not on the SVG's class. Read it when the message is prepared.
            const statusWrap = memberElement.querySelector('[class*="userStatusWrap"][aria-label]');
            const label = (statusWrap?.getAttribute('aria-label') || '').toLowerCase();
            const fill = statusWrap?.querySelector('svg path[fill]')?.getAttribute('fill')?.toLowerCase() || '';
            if (/\b(is )?online\b/.test(label) || fill.includes('userstatusonline')) statusEmoji = '🟢 ';
            else if (/\b(idle|away)\b/.test(label) || fill.includes('userstatusidle') || fill.includes('userstatusaway')) statusEmoji = '🟡 ';
            else if (/\boffline\b/.test(label) || fill.includes('userstatusoffline')) statusEmoji = '⚫ ';
            else statusEmoji = '⚪ '; // Unknown is not the same as offline.
        }

        const statusStr = memberCurrentStatus(memberElement, id, settings);

        // Stat Fetching Engine
        if (settings.battlestats || settings.ffscouter) {
            battleStatsStr = await getCombinedStatsString(id, settings);
        }

        const linkedName = playerMarkdownLink(name, id);
        const attackLink = markdownLink('Attack', `https://www.torn.com/page.php?sid=attack&user2ID=${id}`);
        const details = [attackLink];
        details.push(statusStr);
        if (battleStatsStr) details.push(battleStatsStr);

let message = `${statusEmoji}${linkedName} - ${details.join(' - ')}`;

if (isChain) {
    message = `🚨 Retaliation: Please Hospitalize 🚨\n${message}`;
}

        return message;
    }

    async function handleListCopyClick(e, button, memberElement, isChain = false) {
        e.preventDefault();
        e.stopPropagation();
        const message = await buildListMessage(memberElement, isChain);
        if (!message) return;
        copyToClipboard(message);
        button.textContent = '✅';
        setTimeout(() => { button.textContent = '📄'; }, 1500);
    }

    async function handleFactionCopyClick(e, button, isLeftFaction) {
        e.preventDefault();
        e.stopPropagation();
        if (debug) console.log('[GNSC-Debug] Faction copy process started.');

        const settings = loadSettings();
        if (!settings.apiKey) {
            const originalText = button.textContent;
            button.textContent = '🔑';
            button.title = 'TornStats API key is required for Faction extraction.';
            setTimeout(() => {
                button.textContent = '📋';
                button.title = 'Copy Faction Member List';
            }, 3000);
            return;
        }

        button.textContent = '...';

        const warInfo = document.querySelector('.faction-war-info');
        if (!warInfo) {
            if (debug) console.error('[GNSC-Debug] Could not find .faction-war-info container.');
            button.textContent = '❓';
            button.title = 'Could not find faction info container.';
            setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
            return;
        }

        const factionLinks = warInfo.querySelectorAll('a[href*="factions.php?step=profile&ID="]');
        if (factionLinks.length < 2) {
            if (debug) console.error('[GNSC-Debug] Could not find both faction links in the header.');
            button.textContent = '❓';
            button.title = 'Could not find faction links.';
            setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
            return;
        }

        const targetFactionLink = isLeftFaction ? factionLinks[0] : factionLinks[1];
        const factionIdMatch = targetFactionLink.href.match(/ID=(\d+)/);
        if (!factionIdMatch) {
            if (debug) console.error('[GNSC-Debug] Could not extract faction ID from link:', targetFactionLink.href);
            button.textContent = '❓';
            button.title = 'Could not parse faction ID.';
            setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
            return;
        }
        const factionId = factionIdMatch[1];
        if (debug) console.log(`[GNSC-Debug] Identified Target Faction ID: ${factionId}`);

        const apiUrl = `https://www.tornstats.com/api/v2/${settings.apiKey}/spy/faction/${factionId}`;
        if (debug) console.log(`[GNSC-Debug] Fetching faction data from TornStats: ${apiUrl}`);

        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            timeout: 10000,
            onload: async (response) => {
                if (response.status !== 200) {
                    if (debug) console.error(`[GNSC-Debug] TornStats API responded with status: ${response.status}`);
                    button.textContent = '❌';
                    button.title = `TornStats API Error: ${response.status}`;
                    setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
                    return;
                }

                if (debug) console.log('[GNSC-Debug] Received raw response from TornStats:', response.responseText);
                const data = JSON.parse(response.responseText);

                if (!data.status || !data.faction || !data.faction.members) {
                    if (debug) console.error('[GNSC-Debug] Invalid or unsuccessful response from TornStats API.', data);
                    button.textContent = '❓';
                    button.title = data.message || 'Invalid API response.';
                    setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
                    return;
                }

                const members = data.faction.members;
                if (debug) console.log(`[GNSC-Debug] Found ${Object.keys(members).length} members in API response.`);

                // Identify members needing FFScouter fallback (Missing TS data or > 6 months old)
                let missingIds = [];
                if (settings.ffscouter && settings.ffApiKey) {
                    for (const id in members) {
                        const member = members[id];
                        let needsFF = true;
                        if (member.spy && typeof member.spy.total !== 'undefined' && member.spy.timestamp) {
                            const ageSeconds = Math.floor(Date.now() / 1000) - member.spy.timestamp;
                            if (ageSeconds < SIX_MONTHS_SECONDS) {
                                needsFF = false; // Valid & fresh enough
                            }
                        }
                        if (needsFF) missingIds.push(id);
                    }
                }

                let ffDataMap = {};
                if (missingIds.length > 0) {
                    button.textContent = 'FF...';
                    try {
                        const ffResults = await fetchFFScouterSpy(settings.ffApiKey, missingIds.join(','), true);
                        if (Array.isArray(ffResults)) {
                            ffResults.forEach(r => ffDataMap[r.player_id] = r);
                        }
                    } catch(e) {
                        if (debug) console.error("[GNSC-Debug] Faction FFScouter batch error", e);
                    }
                }

                let factionData = [];

                for (const id in members) {
                    const member = members[id];
                    const name = member.name;
                    let statsString = "(Stats: N/A)";

                    // Merge formatted strings based on the best available data
                    if (ffDataMap[id]) {
                        statsString = formatFFScouterString(ffDataMap[id]);
                    } else if (member.spy && typeof member.spy.total !== 'undefined') {
                        statsString = formatBattleStatsString(member.spy, settings.battleStatsFormat);
                    }

                    if (debug) console.log(`[GNSC-Debug] Processing member: ${name} [${id}], Stats: ${statsString}`);

                    const profileLink = playerMarkdownLink(name, id);
                    const attackLink = markdownLink('Attack', `https://www.torn.com/page.php?sid=attack&user2ID=${id}`);
                    const dataString = `${profileLink} | ${attackLink} | ${statsString}`;

                    factionData.push(dataString);
                }

                const finalContent = factionData.join('\n');
                if (debug) console.log('[GNSC-Debug] Final content to be copied:\n', finalContent);
                copyToClipboard(finalContent);

                button.textContent = '✅';
                setTimeout(() => { button.textContent = '📋'; }, 2000);
            },
            onerror: (error) => {
                if (debug) console.error('[GNSC-Debug] Error calling TornStats API:', error);
                button.textContent = '❌';
                button.title = 'Error calling TornStats API.';
                setTimeout(() => { button.textContent = '📋'; button.title = 'Copy Faction Member List'; }, 3000);
            },
            ontimeout: () => {
                 if (debug) console.error('[GNSC-Debug] Faction fetch timed out.');
                 button.textContent = '⏰';
                 setTimeout(() => { button.textContent = '📋'; }, 3000);
            }
        });
    }

    // --- Utility Functions ---

    function formatBattleStatsString(spyResult, format) {
        if (!spyResult || typeof spyResult.total === 'undefined') return "(Stats: N/A)";

        // Spy timestamps still guide TornStats/FFScouter selection, but are not
        // displayed beside the player's live status or hospital-release time.
        const totalStr = `Total: ${formatNumber(spyResult.total)}`;

        switch (format) {
            case 'highest':
                const stats = {
                    'Str': spyResult.strength,
                    'Def': spyResult.defense,
                    'Spd': spyResult.speed,
                    'Dex': spyResult.dexterity
                };
                const highestStatName = Object.keys(stats).reduce((a, b) => stats[a] > stats[b] ? a : b);
                const highestStatValue = formatNumber(stats[highestStatName]);
                return `(Highest: ${highestStatName} ${highestStatValue} | ${totalStr})`;

            case 'total':
                return `(${totalStr})`;

            case 'all':
            default:
                const str = `Str: ${formatNumber(spyResult.strength)}`;
                const def = `Def: ${formatNumber(spyResult.defense)}`;
                const spd = `Spd: ${formatNumber(spyResult.speed)}`;
                const dex = `Dex: ${formatNumber(spyResult.dexterity)}`;
                return `(${str} | ${def} | ${spd} | ${dex} | ${totalStr})`;
        }
    }

    function formatFFScouterString(ffData) {
        if (!ffData || !ffData.bs_estimate) return "(FFScouter: N/A)";
        // Observation age is used for freshness decisions, not in shared text.
        return `(FFScouter: ~Total: ${formatNumber(ffData.bs_estimate)})`;
    }

    function formatNumber(num) {
        if (num < 1e3) return num;
        if (num >= 1e3 && num < 1e6) return +(num / 1e3).toFixed(2) + "K";
        if (num >= 1e6 && num < 1e9) return +(num / 1e6).toFixed(2) + "M";
        if (num >= 1e9 && num < 1e12) return +(num / 1e9).toFixed(2) + "B";
        if (num >= 1e12 && num < 1e15) return +(num / 1e12).toFixed(2) + "T";
        if (num >= 1e15) return +(num / 1e15).toFixed(2) + "Q";
    };

    function formatRemainingTime(totalSeconds) {
        if (totalSeconds <= 0) return "0s";
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return [hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', seconds > 0 ? `${seconds}s` : ''].filter(Boolean).join(' ');
    }

    function formatTimeDifference(timestamp) {
        const seconds = Math.floor(Date.now() / 1000) - timestamp;
        if (seconds < 60) return `${Math.floor(seconds)}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
        if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo ago`;
        return `${Math.floor(seconds / 31536000)}y ago`;
    }

    function fetchTornStatsSpy(apiKey, userId, verbose = false) {
        const url = `https://www.tornstats.com/api/v2/${apiKey}/spy/user/${userId}`;
        if (debug && verbose) console.log(`[GNSC-Debug] [TornStats Spy] Requesting URL: ${url}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                timeout: 10000, // 10 second timeout
                onload: (response) => {
                    if (debug && verbose) console.log(`[GNSC-Debug] [TornStats Spy] Response received. Status: ${response.status}`);
                    if (response.status === 200) {
                        try {
                            const parsed = JSON.parse(response.responseText);
                            resolve(parsed);
                        } catch (e) {
                            console.error("[GNSC-Debug] JSON Parse Error:", e);
                            reject(new Error("Failed to parse JSON from TornStats."));
                        }
                    } else {
                        reject(new Error(`API responded with status ${response.status}`));
                    }
                },
                onerror: (error) => {
                    if (debug) console.error("[GNSC-Debug] GM_xmlhttpRequest Network Error:", error);
                    reject(error);
                },
                ontimeout: () => {
                    if (debug) console.error("[GNSC-Debug] GM_xmlhttpRequest Timed Out.");
                    reject(new Error("Request Timed Out"));
                }
            });
        });
    }

    function fetchFFScouterSpy(apiKey, userIds, verbose = false) {
        const url = `https://ffscouter.com/api/v1/get-stats?key=${apiKey}&targets=${userIds}`;
        if (debug && verbose) console.log(`[GNSC-Debug] [FFScouter] Requesting URL: ${url}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                timeout: 10000,
                onload: (response) => {
                    if (debug && verbose) console.log(`[GNSC-Debug] [FFScouter] Response received. Status: ${response.status}`);
                    if (response.status === 200) {
                        try {
                            const parsed = JSON.parse(response.responseText);
                            if (parsed.status === false) {
                                reject(new Error(parsed.message || "FFScouter API Error"));
                            } else {
                                resolve(parsed); // Returns array of objects
                            }
                        } catch (e) {
                            reject(new Error("Failed to parse JSON from FFScouter."));
                        }
                    } else {
                        reject(new Error(`API responded with status ${response.status}`));
                    }
                },
                onerror: (error) => reject(error),
                ontimeout: () => reject(new Error("Request Timed Out"))
            });
        });
    }

    function loadSettings() {
        return GNSC_getValue('tornProfileFormatterSettings', {
            attack: true, faction: false, company: false,
            timeRemaining: true, releaseTime: true,
            battlestats: false, activity: true, apiKey: '',
            battleStatsFormat: 'all', ffscouter: false, ffApiKey: ''
        });
    }

    function updateBattleStatsAvailability() {
        const battleStatsCheckbox = document.getElementById('gnsc-check-battlestats');
        const battleStatsLabel = document.querySelector('label[for="gnsc-check-battlestats"]');
        const apiKeyInput = document.getElementById('gnsc-api-key');
        const formatWrapper = document.getElementById('gnsc-battlestats-format-wrapper');

        const ffCheckbox = document.getElementById('gnsc-check-ffscouter');
        const ffLabel = document.querySelector('label[for="gnsc-check-ffscouter"]');
        const ffApiKeyInput = document.getElementById('gnsc-ff-api-key');

        if (battleStatsCheckbox && apiKeyInput) {
            const hasApiKey = !!apiKeyInput.value.trim();
            battleStatsCheckbox.disabled = !hasApiKey;
            battleStatsLabel.classList.toggle('disabled', !hasApiKey);
            if (!hasApiKey) battleStatsCheckbox.checked = false;

            const showFormatOptions = battleStatsCheckbox.checked && hasApiKey;
            if (formatWrapper) formatWrapper.style.display = showFormatOptions ? 'flex' : 'none';
        }

        if (ffCheckbox && ffApiKeyInput) {
            const hasFfKey = !!ffApiKeyInput.value.trim();
            ffCheckbox.disabled = !hasFfKey;
            ffLabel.classList.toggle('disabled', !hasFfKey);
            if (!hasFfKey) ffCheckbox.checked = false;
        }
    }

    function saveSettings() {
        const apiKeyInput = document.getElementById('gnsc-api-key');
        const hasApiKey = !!(apiKeyInput && apiKeyInput.value.trim());

        const ffApiKeyInput = document.getElementById('gnsc-ff-api-key');
        const hasFfApiKey = !!(ffApiKeyInput && ffApiKeyInput.value.trim());

        const settings = {
            attack: document.getElementById('gnsc-check-attack').checked,
            faction: document.getElementById('gnsc-check-faction')?.checked || false,
            company: document.getElementById('gnsc-check-company')?.checked || false,
            timeRemaining: document.getElementById('gnsc-check-timeRemaining')?.checked || false,
            releaseTime: document.getElementById('gnsc-check-releaseTime')?.checked || false,
            activity: document.getElementById('gnsc-check-activity').checked,
            battlestats: hasApiKey && document.getElementById('gnsc-check-battlestats')?.checked || false,
            apiKey: apiKeyInput?.value || '',
            battleStatsFormat: document.getElementById('gnsc-select-battlestats-format')?.value || 'all',
            ffscouter: hasFfApiKey && document.getElementById('gnsc-check-ffscouter')?.checked || false,
            ffApiKey: ffApiKeyInput?.value || ''
        };
        GNSC_setValue('tornProfileFormatterSettings', settings);
    }

    function copyToClipboard(text) {
        if(debug) console.log(`[GNSC-Debug] Creating textarea for clipboard copy...`);
        const tempTextarea = document.createElement('textarea');
        tempTextarea.style.position = 'fixed';
        tempTextarea.style.left = '-9999px';
        tempTextarea.value = text;
        document.body.appendChild(tempTextarea);
        tempTextarea.select();
        try {
            const success = document.execCommand('copy');
            if(debug) console.log(`[GNSC-Debug] document.execCommand('copy') result: ${success}`);
        } catch (err) {
            if (debug) console.error('[GNSC-Debug] Clipboard copy failed.', err);
        }
        document.body.removeChild(tempTextarea);
    }


    // --- Script Entry Point ---
    // Ranked-war controls are only mounted on the actual war view. The former
    // code started a document-wide search on every factions.php page and
    // immediately traversed the enemy roster twice.
    const onRankedWarView = () =>
        location.pathname === '/factions.php' && location.hash.startsWith('#/war/rank');

    if (location.pathname.includes('profiles.php')) initProfilePage();
    initMiniProfile();

    let observedEnemyList = null;
    let enemyListObserver = null;
    let mountObserver = null;
    let mountCheckScheduled = false;
    let pendingEnemyRows = new Set();
    let pendingEnemyHeader = null;
    let enemyUpdateScheduled = false;

    function stopWarObservers() {
        mountObserver?.disconnect();
        mountObserver = null;
        enemyListObserver?.disconnect();
        enemyListObserver = null;
        observedEnemyList = null;
        pendingEnemyRows.clear();
        pendingEnemyHeader = null;
    }

    // Collect candidates and read any CSS-only widths before changing a single
    // row. This avoids layout thrashing while supporting rows without inline width.
    function flushEnemyRows() {
        enemyUpdateScheduled = false;
        if (!onRankedWarView()) {
            pendingEnemyRows.clear();
            pendingEnemyHeader = null;
            return;
        }
        const candidates = [];
        if (pendingEnemyHeader?.isConnected) candidates.push({row: pendingEnemyHeader, header: true});
        pendingEnemyHeader = null;
        const rows = pendingEnemyRows;
        pendingEnemyRows = new Set();
        for (const row of rows) {
            if (row.isConnected && row.closest('.enemy-faction')) candidates.push({row, header: false});
        }
        // Read phase: only measure elements with no width declared inline.
        const ready = candidates.map(({row, header}) => {
            const memberCell = row.querySelector(':scope > .member');
            const needsWidth = memberCell && !memberCell.style.getPropertyValue('width').trim();
            const width = needsWidth ? memberCell.getBoundingClientRect().width : 0;
            return {row, header, width};
        });
        // Write phase: all inserts are grouped after the reads.
        for (const {row, header, width} of ready) addWarLinkCell(row, header, width);
    }
    function queueEnemyRow(row) {
        if (!row || processedEnemyRows.has(row) || pendingEnemyRows.has(row)) return;
        pendingEnemyRows.add(row);
        if (!enemyUpdateScheduled) {
            enemyUpdateScheduled = true;
            requestAnimationFrame(flushEnemyRows);
        }
    }
    function bindEnemyList() {
        if (!onRankedWarView()) return false;
        const list = document.querySelector('.enemy-faction ul.members-list');
        if (!list) return false;
        if (list === observedEnemyList) return true;
        enemyListObserver?.disconnect();
        observedEnemyList = list;
        // Stage the header and all initial rows for one coherent layout update.
        const header = list.previousElementSibling;
        if (header?.matches('.white-grad') && !processedEnemyRows.has(header)) pendingEnemyHeader = header;
        for (const row of list.querySelectorAll(':scope > li.enemy')) queueEnemyRow(row);
        enemyListObserver = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.matches('li.enemy')) queueEnemyRow(node);
                    else if (node.querySelectorAll) {
                        for (const row of node.querySelectorAll('li.enemy')) queueEnemyRow(row);
                    }
                }
            }
        });
        enemyListObserver.observe(list, {childList: true, subtree: true});
        return true;
    }
    function scheduleMountCheck() {
        if (mountCheckScheduled) return;
        mountCheckScheduled = true;
        requestAnimationFrame(() => {
            mountCheckScheduled = false;
            if (!onRankedWarView()) return;
            if (bindEnemyList()) {
                mountObserver?.disconnect();
                mountObserver = null;
            }
        });
    }
    function activateWarView() {
        if (!onRankedWarView()) { stopWarObservers(); return; }
        initRankedWarPage();
        if (observedEnemyList?.isConnected) return;
        // No polling timer. Observe only until the roster has mounted; at most
        // one selector lookup per animation frame, regardless of mutation count.
        if (bindEnemyList()) return;
        if (!mountObserver) {
            mountObserver = new MutationObserver(scheduleMountCheck);
            mountObserver.observe(document.body, {childList: true, subtree: true});
        }
    }
    if (location.pathname === '/factions.php') {
        window.addEventListener('hashchange', () => { initChainPage(); activateWarView(); });
        initChainPage();
        activateWarView();
    }

    // --- Live Data Interception ---
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const isKnownDataSource = url.includes("step=getwarusers") || url.includes("step=getProcessBarRefreshData") || url.includes("sidebarAjaxAction.php?q=sync");

        if (!isKnownDataSource) return originalFetch(...args);

        const response = await originalFetch(...args);
        const clone = response.clone();

        clone.json().then(json => {
            let members = null;
            if (json.warDesc?.members) members = json.warDesc.members;
            else if (json.userStatuses) members = json.userStatuses;
            else if (json.status?.bar?.hospital?.end) {
                const userId = json.user?.userID;
                if (userId) hospTime[userId] = json.status.bar.hospital.end;
                return;
            } else if (json.user?.userID) {
                const userId = json.user.userID;
                if (hospTime[userId]) delete hospTime[userId];
                return;
            } else return;

            Object.keys(members).forEach((id) => {
                const status = members[id].status || members[id];
                const userId = members[id].userID || id;
                if (status.text === "Hospital") {
                    hospTime[userId] = status.updateAt;
                } else if (hospTime[userId]) {
                   delete hospTime[userId];
                }
            });
        }).catch(err => { if (debug) console.error("[GNSC-Debug] Error parsing fetch JSON.", err)});

        return response;
    };
})();