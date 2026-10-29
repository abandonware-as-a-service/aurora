// Production controller for the Aurora dApp (Dusk Network + Dusk Wallet via Dusk Connect).
import {APP_CONFIG} from './config.js';
import {
  connectAuroraApp,
  readProtocolStats,
  readAllVaults,
  readSolverCommitment,
  readLeaderboard,
  prepareCreateVault,
  prepareFundVault,
  prepareAddHint,
  prepareCommitSolution,
  prepareRevealSolution,
  prepareReclaimExpired,
  prepareSetDisclosure,
  STATUS_OPEN,
  STATUS_CRACKED,
  STATUS_RECLAIMED,
} from './client.js';
import {
  hashAnswer,
  hashCommitment,
  computeShadowTag,
  bytesToHex,
  randomSaltHex,
  shortKey,
  formatLuxToDusk,
  parseDuskToLux,
} from './crypto.js';

const state = {
  config: APP_CONFIG,
  dusk: null,
  unsubscribeWallet: null,
  account: null,
  balanceLux: null,
  nodeReachable: false,
  nodeError: null,
  vaultFilter: 'all',
  selectedVaultId: null,
  vaults: [],
  leaderboard: [],
  stats: null,
  activeCommit: null,
  txHistory: [],
};

function draftStorageKey(vaultId, account) {
  return `aurora.draft:${state.config.contractId}:${vaultId}:${account || 'guest'}`;
}

function loadDraft(vaultId, account) {
  const key = draftStorageKey(vaultId, account);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        answer: String(parsed.answer ?? ''),
        salt: String(parsed.salt || randomSaltHex(12)),
        disclose: Boolean(parsed.disclose),
        alias: String(parsed.alias ?? ''),
      };
    }
  } catch {}
  return {
    answer: '',
    salt: randomSaltHex(12),
    disclose: false,
    alias: '',
  };
}

function saveDraft(vaultId, account, draft) {
  try {
    localStorage.setItem(draftStorageKey(vaultId, account), JSON.stringify(draft));
  } catch {}
}

function showToast(message, kind = 'ok') {
  const el = document.getElementById('toastBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `toast-banner ${kind}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.add('hidden');
  }, 7000);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function txHistoryStorageKey() {
  return `aurora.txHistory:${state.config.contractId}`;
}

function lastPreparedStorageKey() {
  return `aurora.lastPrepared:${state.config.contractId}`;
}

function loadTxHistory() {
  try {
    const raw = localStorage.getItem(txHistoryStorageKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.txHistory = parsed.slice(0, 30);
      }
    }
  } catch {}
  try {
    const rawPrep = localStorage.getItem(lastPreparedStorageKey());
    if (rawPrep) {
      const parsedPrep = JSON.parse(rawPrep);
      if (parsedPrep && parsedPrep.fnName) {
        renderPreparedCallPreview(parsedPrep);
      }
    }
  } catch {}
}

function saveTxHistory() {
  try {
    localStorage.setItem(txHistoryStorageKey(), JSON.stringify(state.txHistory.slice(0, 30)));
  } catch {}
}

function renderPreparedCallPreview(preview) {
  const box = document.getElementById('lastPreparedBox');
  const fnEl = document.getElementById('lastPreparedFn');
  const preEl = document.getElementById('lastPreparedJson');
  if (!box || !fnEl || !preEl || !preview) return;
  box.classList.remove('hidden');
  fnEl.textContent = `${preview.fnName} (${preview.privacy})`;
  preEl.textContent = JSON.stringify(preview.payload, null, 2);
}

function recordPreparedCall(prepared) {
  if (!prepared) return;
  const preview = {
    fnName: prepared.fnName,
    privacy: prepared.privacy,
    payload: {
      contractId: `${String(prepared.contractId).slice(0, 14)}…`,
      fnName: prepared.fnName,
      privacy: prepared.privacy,
      deposit: prepared.deposit,
      fnArgs: `${String(prepared.fnArgs).slice(0, 38)}… (${(String(prepared.fnArgs).length - 2) / 2} bytes rkyv)`,
    },
  };
  renderPreparedCallPreview(preview);
  try {
    localStorage.setItem(lastPreparedStorageKey(), JSON.stringify(preview));
  } catch {}
}

function pushTxActivity(entry) {
  const existingIdx = entry.txHash
    ? state.txHistory.findIndex(item => item.txHash === entry.txHash && item.fnName === entry.fnName)
    : -1;
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    timestamp: new Date().toLocaleTimeString(),
    ...entry,
  };
  if (existingIdx >= 0) {
    state.txHistory[existingIdx] = {
      ...state.txHistory[existingIdx],
      ...entry,
      timestamp: record.timestamp,
    };
  } else {
    state.txHistory.unshift(record);
  }
  saveTxHistory();
  renderTxFeed();
}

const WALLET_AUTOCONNECT_KEY = 'aurora.wallet.autoconnect';

function shouldAutoConnectWallet() {
  try {
    return localStorage.getItem(WALLET_AUTOCONNECT_KEY) !== '0';
  } catch {
    return true;
  }
}

function setAutoConnectPreference(enabled) {
  try {
    localStorage.setItem(WALLET_AUTOCONNECT_KEY, enabled ? '1' : '0');
  } catch {}
}

function isWalletConnected() {
  const ws = state.dusk?.state;
  return Boolean(ws?.selectedAddress && (ws?.authorized || shouldAutoConnectWallet()));
}

async function signAndSubmit(preparedTx, label) {
  recordPreparedCall(preparedTx);

  if (!state.dusk) {
    throw new Error('Dusk Connect client is not initialized.');
  }
  if (!isWalletConnected()) {
    await state.dusk.connect();
    setAutoConnectPreference(true);
  }
  await state.dusk.ensureChain({chainId: state.config.chainId});

  showToast(`Awaiting Dusk Wallet signature for ${preparedTx.fnName}…`, 'ok');
  const submitted = await state.dusk.wallet.sendContractCall(preparedTx);
  const txHash = String(submitted?.hash || '');

  pushTxActivity({
    fnName: preparedTx.fnName,
    status: 'submitted',
    txHash,
    summary: `${label} — Submitted to Dusk Network`,
  });

  showToast(`Transaction submitted (${txHash.slice(0, 12)}…) — waiting for execution…`, 'ok');

  try {
    const receipt = await state.dusk.waitForTxReceipt(txHash, {timeoutMs: 60000});
    if (receipt?.ok === false) {
      pushTxActivity({
        fnName: preparedTx.fnName,
        status: 'failed',
        txHash,
        summary: `Execution failed: ${receipt.error || 'Contract reverted'}`,
      });
      showToast(`Contract execution failed: ${receipt.error || 'reverted'}`, 'err');
    } else {
      pushTxActivity({
        fnName: preparedTx.fnName,
        status: 'executed',
        txHash,
        summary: `${label} — Executed on DuskVM`,
      });
      showToast(`${label} confirmed on DuskVM!`, 'ok');
    }
  } catch {
    // Even if WebSocket tracking is unavailable on the node, refresh state
  }

  await syncFromNode();
}

async function refreshWalletBalance() {
  if (!state.dusk || !isWalletConnected()) {
    state.balanceLux = null;
    return;
  }
  try {
    const raw = await state.dusk.wallet.getPublicBalance();
    const val = typeof raw === 'object' && raw !== null
      ? (raw.balance ?? raw.value ?? raw.available ?? null)
      : raw;
    state.balanceLux = val != null ? BigInt(val) : null;
  } catch {
    state.balanceLux = null;
  }
}

async function syncFromNode() {
  if (!state.dusk) return;

  await renderWalletHeader();

  try {
    const [stats, vaults, leaderboard] = await Promise.all([
      readProtocolStats(state.dusk),
      readAllVaults(state.dusk),
      readLeaderboard(state.dusk),
    ]);

    state.nodeReachable = true;
    state.nodeError = null;
    state.stats = stats;
    state.vaults = vaults;
    state.leaderboard = leaderboard;

    if (
      (state.selectedVaultId == null || !state.vaults.some(v => v.id === state.selectedVaultId)) &&
      state.vaults.length > 0
    ) {
      state.selectedVaultId = state.vaults[0].id;
    }

    state.activeCommit =
      state.account && state.selectedVaultId != null
        ? await readSolverCommitment(state.dusk, state.selectedVaultId, state.account)
        : null;
  } catch (err) {
    state.nodeReachable = false;
    state.nodeError = err?.message || String(err);
  }

  await refreshWalletBalance();
  await renderWalletHeader();
  renderStats();
  renderVaultGallery();
  await renderVaultInspector();
  renderLeaderboard();
  renderTxFeed();
}

async function renderWalletHeader() {
  const netLabel = document.getElementById('networkBadgeLabel');
  if (netLabel) {
    netLabel.textContent = state.config.networkLabel;
  }

  const contractEl = document.getElementById('activeContractShort');
  if (contractEl) {
    contractEl.textContent = `0x${state.config.contractId.slice(0, 8)}…${state.config.contractId.slice(-6)}`;
    contractEl.title = `0x${state.config.contractId}`;
  }

  const walletState = state.dusk?.state;
  const connected = isWalletConnected();
  state.account = connected ? (walletState?.selectedAddress || null) : null;

  const statusBadge = document.getElementById('walletStatusBadge');
  const connectBtn = document.getElementById('connectWalletBtn');
  const keyEl = document.getElementById('activeAccountKey');
  const shadowEl = document.getElementById('activeShadowTag');
  const privacyShadowEl = document.getElementById('privacyCardShadow');
  const balEl = document.getElementById('activeBalanceDusk');

  if (connected && state.account) {
    const shadow = await computeShadowTag(state.account);
    if (statusBadge) {
      statusBadge.textContent = `Connected (${walletState.providerInfo?.name || 'Dusk Wallet'})`;
    }
    if (connectBtn) {
      connectBtn.textContent = 'Disconnect Wallet';
    }
    if (keyEl) {
      keyEl.textContent = shortKey(state.account);
      keyEl.title = state.account;
    }
    if (shadowEl) shadowEl.textContent = shadow;
    if (privacyShadowEl) privacyShadowEl.textContent = shadow;
    if (balEl) {
      balEl.textContent = state.balanceLux != null
        ? `${formatLuxToDusk(state.balanceLux)} DUSK`
        : 'Connected';
    }
  } else {
    if (statusBadge) {
      statusBadge.textContent = walletState?.installed
        ? 'Dusk Wallet detected — click Connect Dusk Wallet'
        : 'Read-only mode (Install or unlock Dusk Wallet to sign transactions)';
    }
    if (connectBtn) {
      connectBtn.textContent = 'Connect Dusk Wallet';
    }
    if (keyEl) keyEl.textContent = 'Not connected';
    if (shadowEl) shadowEl.textContent = 'Shadow #------';
    if (privacyShadowEl) privacyShadowEl.textContent = 'Shadow #------';
    if (balEl) balEl.textContent = '—';
  }
}

function renderStats() {
  if (!state.stats) {
    document.getElementById('statVaultCount').textContent = '—';
    document.getElementById('statLockedBounty').textContent = '—';
    document.getElementById('statPaidBounty').textContent = '—';
    document.getElementById('statCrackedCount').textContent = '—';
    return;
  }
  document.getElementById('statVaultCount').textContent = String(state.stats.vaultCount);
  document.getElementById('statLockedBounty').textContent = `${formatLuxToDusk(state.stats.totalLockedLux)} DUSK`;
  document.getElementById('statPaidBounty').textContent = `${formatLuxToDusk(state.stats.totalPaidLux)} DUSK`;
  document.getElementById('statCrackedCount').textContent = String(state.stats.totalCracked);
}

function renderVaultGallery() {
  const listEl = document.getElementById('vaultList');
  if (!listEl) return;

  if (!state.nodeReachable) {
    listEl.innerHTML = `
      <div class="bot-item">
        <strong>Awaiting Contract Connection</strong><br/>
        <span style="color:var(--text-secondary);">
          Could not query contract <code>0x${escapeHtml(state.config.contractId.slice(0, 12))}…</code> on <code>${escapeHtml(state.config.nodeUrl)}</code>.<br/>
          ${escapeHtml(state.nodeError || '')}
        </span>
      </div>
    `;
    return;
  }

  const filtered = state.vaults.filter(v => {
    if (state.vaultFilter === 'open') return v.status === STATUS_OPEN && !v.isExpired;
    if (state.vaultFilter === 'cracked') return v.status === STATUS_CRACKED;
    if (state.vaultFilter === 'expired') return v.isExpired || v.status === STATUS_RECLAIMED;
    return true;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="bot-item">
        ${state.vaults.length === 0
          ? 'No Aurora vaults have been forged on this contract yet. Click "+ Forge New Vault" to create Vault #0!'
          : 'No vaults match the selected filter.'}
      </div>
    `;
    return;
  }

  listEl.innerHTML = filtered
    .map(v => {
      const isSelected = v.id === state.selectedVaultId;
      const statusClass = v.status === STATUS_CRACKED
        ? 'status-cracked'
        : v.status === STATUS_RECLAIMED || v.isExpired
          ? 'status-expired'
          : 'status-open';

      let footerRight = '';
      if (v.status === STATUS_CRACKED) {
        const icon = v.disclosed ? '👑' : '🕶️';
        footerRight = `<span class="winner-mini ${v.disclosed ? '' : 'anon'}">${icon} ${escapeHtml(v.winnerLabel)}</span>`;
      } else if (v.status === STATUS_RECLAIMED) {
        footerRight = `<span class="winner-mini">Refunded to creator</span>`;
      } else if (v.expiresAt > 0) {
        footerRight = `<span class="winner-mini">Expires Block #${v.expiresAt}</span>`;
      } else {
        footerRight = `<span class="winner-mini">No expiry</span>`;
      }

      return `
        <article class="vault-card ${isSelected ? 'selected' : ''}" data-vault-id="${v.id}">
          <div class="vault-card-top">
            <div class="vault-id-cat">
              <span>VAULT #${v.id}</span>
              <span class="cat-badge">${escapeHtml(v.category)}</span>
            </div>
            <span class="status-badge ${statusClass}">${escapeHtml(v.statusLabel)}</span>
          </div>
          <h3 class="vault-card-title">${escapeHtml(v.title)}</h3>
          <p class="vault-card-lore">${escapeHtml(v.lore)}</p>
          <div class="vault-card-foot">
            <span class="bounty-tag">✦ ${escapeHtml(v.bountyDusk)} DUSK</span>
            ${footerRight}
          </div>
        </article>
      `;
    })
    .join('');
}

async function renderVaultInspector() {
  const container = document.getElementById('vaultInspector');
  if (!container) return;

  if (!state.nodeReachable) {
    container.innerHTML = `
      <div class="inspector-header">
        <div>
          <span class="status-badge status-open">${escapeHtml(state.config.networkLabel)}</span>
          <h2 class="inspector-title">Waiting for Contract Connection</h2>
        </div>
      </div>
      <div class="riddle-box">
        <p class="riddle-prompt">
          Could not reach Aurora contract <code>0x${escapeHtml(state.config.contractId.slice(0, 16))}…</code> on <strong>${escapeHtml(state.config.networkLabel)}</strong>.<br/>
          Click <strong>↻ Sync</strong> in the top bar once the node is online.
        </p>
      </div>
    `;
    return;
  }

  const vault = state.vaults.find(v => v.id === state.selectedVaultId);
  if (!vault) {
    container.innerHTML = `<p class="panel-sub">Select a vault from the gallery or click "+ Forge New Vault" to create one.</p>`;
    return;
  }

  const activeAccount = state.account;
  const isCreator = Boolean(activeAccount && vault.creator === activeAccount);
  const draft = loadDraft(vault.id, activeAccount);
  const activeShadow = activeAccount ? await computeShadowTag(activeAccount) : 'Shadow #------';

  const statusClass = vault.status === STATUS_CRACKED
    ? 'status-cracked'
    : vault.status === STATUS_RECLAIMED || vault.isExpired
      ? 'status-expired'
      : 'status-open';

  let commitHashPreview = activeAccount
    ? 'Enter an answer to preview your blinded commitment…'
    : 'Connect your Dusk Wallet to compute a commitment bound to your BlsPublicKey…';

  if (draft.answer.trim() && activeAccount) {
    const ansBytes = await hashAnswer(draft.answer);
    const comBytes = await hashCommitment(vault.id, activeAccount, ansBytes, draft.salt);
    commitHashPreview = `0x${bytesToHex(comBytes).slice(0, 36)}…`;
  }

  container.innerHTML = `
    <div class="inspector-header">
      <div>
        <div class="vault-id-cat">
          <span>VAULT #${vault.id}</span>
          <span class="cat-badge">${escapeHtml(vault.category)}</span>
          <span class="status-badge ${statusClass}">${escapeHtml(vault.statusLabel)}</span>
        </div>
        <h2 class="inspector-title">${escapeHtml(vault.title)}</h2>
      </div>
      <div class="inspector-bounty-box">
        <span>Locked Bounty</span>
        <strong>${escapeHtml(vault.bountyDusk)} DUSK</strong>
      </div>
    </div>

    <div class="riddle-box">
      <p class="riddle-prompt">${escapeHtml(vault.lore)}</p>
      <div class="hint-box">
        <strong>Hint:</strong>
        ${vault.hint ? escapeHtml(vault.hint) : '<em>No hint released by creator yet.</em>'}
      </div>
    </div>

    <div class="meta-grid">
      <div class="meta-item">
        <span>Creator (Moonlight)</span>
        <code title="${escapeHtml(vault.creator)}">${escapeHtml(vault.creatorShort)}${isCreator ? ' (You)' : ''}</code>
      </div>
      <div class="meta-item">
        <span>Created / Expires</span>
        <strong>Block #${vault.createdAt} → ${vault.expiresAt > 0 ? `#${vault.expiresAt}` : 'Never'}</strong>
      </div>
      <div class="meta-item">
        <span>Commit Attempts</span>
        <strong>${vault.attempts}</strong>
      </div>
      <div class="meta-item">
        <span>Target SHA-256 Digest</span>
        <code title="0x${vault.answerHashHex}">0x${vault.answerHashHex.slice(0, 16)}…</code>
      </div>
    </div>

    <!-- Secondary Vault Actions: Fund Bounty / Add Hint / Reclaim Expired -->
    <div class="action-bar-row">
      ${vault.status === STATUS_OPEN ? `
        <form id="fundVaultForm" class="inline-action-form">
          <input id="fundAmountInput" type="number" min="1" step="any" value="25" style="width:74px" aria-label="DUSK to add" />
          <button class="secondary-btn small" type="submit">+ Top Up Bounty (DUSK)</button>
        </form>
      ` : ''}

      ${vault.status === STATUS_OPEN && isCreator ? `
        <form id="addHintForm" class="inline-action-form">
          <input id="updateHintInput" type="text" maxlength="240" placeholder="Publish or update hint…" value="${escapeHtml(vault.hint)}" style="width:190px" />
          <button class="ghost-btn small" type="submit">Save Hint</button>
        </form>
      ` : ''}

      ${vault.status === STATUS_OPEN && vault.expiresAt > 0 && isCreator ? `
        <button id="reclaimVaultBtn" class="ghost-btn small" type="button" title="Refunds bounty if current block >= #${vault.expiresAt}">
          Reclaim Expired Bounty (After Block #${vault.expiresAt})
        </button>
      ` : ''}
    </div>

    ${vault.status === STATUS_CRACKED ? `
      <div class="winner-banner">
        <h4>✓ Vault Cracked at Block #${vault.crackedAt}</h4>
        <p style="font-size:12.5px; color: var(--text-secondary);">
          Solved by <strong>${escapeHtml(vault.winnerLabel)}</strong>
          ${vault.disclosed && vault.winnerKey
            ? `— Public Moonlight Key: <code>${escapeHtml(shortKey(vault.winnerKey))}</code>`
            : `— <em>Identity cloaked on-chain (<code>vault_winner</code> key is <code>null</code>)</em>`
          }
        </p>
      </div>
    ` : vault.status === STATUS_RECLAIMED ? `
      <div class="winner-banner" style="border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.08);">
        <h4 style="color: var(--accent-danger);">Vault Expired &amp; Bounty Reclaimed</h4>
        <p style="font-size:12.5px; color: var(--text-secondary);">
          The ${escapeHtml(vault.bountyDusk)} DUSK bounty was refunded to the creator (${escapeHtml(vault.creatorShort)}).
        </p>
      </div>
    ` : `
      <!-- 2-Step Commit-Reveal Cracker -->
      <div class="crack-section">
        <h3>Crack This Vault (2-Step Commit–Reveal)</h3>
        <p class="panel-sub">
          Step 1 anchors a salted commitment bound to your <code>BlsPublicKey</code>. Step 2 reveals your answer at least 1 block later so mempool bots cannot steal your bounty.
        </p>

        <div class="crack-steps">
          <!-- Step 1: Commit -->
          <form id="commitForm" class="step-box">
            <div class="step-box-header">
              <span>Step 1 · Blinded Commit</span>
              <span class="step-num">commit_solution</span>
            </div>

            <label class="form-field">
              <span>Candidate Answer (case &amp; whitespace normalized)</span>
              <input id="crackAnswerInput" type="text" placeholder="Type solution…" value="${escapeHtml(draft.answer)}" required autocomplete="off" />
            </label>

            <div class="form-field">
              <span>Secret Salt (saved locally in browser until reveal)</span>
              <div class="salt-row">
                <input id="crackSaltInput" type="text" value="${escapeHtml(draft.salt)}" required />
                <button id="regenSaltBtn" class="chip-btn" type="button" title="Generate new random salt">↻</button>
              </div>
            </div>

            <div class="hash-preview-box">
              <span class="hash-preview-label">Commitment Bound to Your Key:</span>
              <code id="commitHashPreviewEl">${escapeHtml(commitHashPreview)}</code>
            </div>

            <button class="secondary-btn" type="submit" style="margin-top:auto;">
              1. Sign &amp; Submit Commitment
            </button>
          </form>

          <!-- Step 2: Reveal -->
          <form id="revealForm" class="step-box">
            <div class="step-box-header">
              <span>Step 2 · Reveal &amp; Claim Bounty</span>
              <span class="step-num">reveal_solution</span>
            </div>

            ${state.activeCommit ? `
              <div class="commit-status-pill">
                ✓ On-Chain Commit: 0x${state.activeCommit.hashHex.slice(0, 14)}… (Block #${state.activeCommit.committedAt})
              </div>
            ` : `
              <div class="bot-item">
                No on-chain commitment found for your account on Vault #${vault.id}. Complete Step 1 first.
              </div>
            `}

            <div class="form-field">
              <span>Winner Leaderboard Privacy Choice</span>
              <label class="checkbox-row" style="margin-top:4px;">
                <input id="discloseWinnerCheck" type="checkbox" ${draft.disclose ? 'checked' : ''} />
                <span>
                  <strong>Disclose my identity on the leaderboard</strong><br/>
                  <small style="color:var(--text-muted);">
                    If unchecked, you still receive the ${escapeHtml(vault.bountyDusk)} DUSK payout, but the contract hides your key as <code>null</code> and displays <code>${escapeHtml(activeShadow)}</code>.
                  </small>
                </span>
              </label>
            </div>

            <label class="form-field ${draft.disclose ? '' : 'hidden'}" id="revealAliasField">
              <span>Public Winner Alias (max 32 chars)</span>
              <input id="revealAliasInput" type="text" maxlength="32" value="${escapeHtml(draft.alias)}" placeholder="e.g. Captain Vesper" />
            </label>

            <button class="primary-btn" type="submit" style="margin-top:auto;">
              2. Reveal Answer &amp; Claim ${escapeHtml(vault.bountyDusk)} DUSK
            </button>
          </form>
        </div>
      </div>
    `}
  `;

  bindInspectorEvents(vault, draft);
}

function bindInspectorEvents(vault, draft) {
  const fundForm = document.getElementById('fundVaultForm');
  fundForm?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const amtDusk = document.getElementById('fundAmountInput').value;
      const amountLux = parseDuskToLux(amtDusk);
      const tx = await prepareFundVault(state.dusk, {vaultId: vault.id, amountLux});
      await signAndSubmit(tx, `Top up Vault #${vault.id} (+${amtDusk} DUSK)`);
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });

  const hintForm = document.getElementById('addHintForm');
  hintForm?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const hint = document.getElementById('updateHintInput').value;
      const tx = await prepareAddHint(state.dusk, {vaultId: vault.id, hint});
      await signAndSubmit(tx, `Update hint on Vault #${vault.id}`);
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });

  const reclaimBtn = document.getElementById('reclaimVaultBtn');
  reclaimBtn?.addEventListener('click', async () => {
    try {
      const tx = await prepareReclaimExpired(state.dusk, {vaultId: vault.id});
      await signAndSubmit(tx, `Reclaim expired Vault #${vault.id} bounty`);
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });

  const answerInput = document.getElementById('crackAnswerInput');
  const saltInput = document.getElementById('crackSaltInput');
  const regenSaltBtn = document.getElementById('regenSaltBtn');
  const previewEl = document.getElementById('commitHashPreviewEl');
  const discloseCheck = document.getElementById('discloseWinnerCheck');
  const aliasField = document.getElementById('revealAliasField');
  const aliasInput = document.getElementById('revealAliasInput');

  const persistAndPreview = async () => {
    draft.answer = answerInput ? answerInput.value : draft.answer;
    draft.salt = saltInput ? saltInput.value : draft.salt;
    saveDraft(vault.id, state.account, draft);
    if (previewEl && state.account) {
      if (!draft.answer.trim()) {
        previewEl.textContent = 'Enter an answer to preview your blinded commitment…';
      } else {
        const ansBytes = await hashAnswer(draft.answer);
        const comBytes = await hashCommitment(vault.id, state.account, ansBytes, draft.salt);
        previewEl.textContent = `0x${bytesToHex(comBytes).slice(0, 36)}…`;
      }
    }
  };

  answerInput?.addEventListener('input', persistAndPreview);
  saltInput?.addEventListener('input', persistAndPreview);
  regenSaltBtn?.addEventListener('click', () => {
    draft.salt = randomSaltHex(12);
    if (saltInput) saltInput.value = draft.salt;
    persistAndPreview();
  });

  discloseCheck?.addEventListener('change', () => {
    draft.disclose = discloseCheck.checked;
    aliasField?.classList.toggle('hidden', !draft.disclose);
    saveDraft(vault.id, state.account, draft);
  });

  aliasInput?.addEventListener('input', () => {
    draft.alias = aliasInput.value;
    saveDraft(vault.id, state.account, draft);
  });

  const commitForm = document.getElementById('commitForm');
  commitForm?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      if (!isWalletConnected()) {
        await state.dusk.connect();
        setAutoConnectPreference(true);
      }
      const solverAccount = state.dusk.state?.selectedAddress;
      if (!solverAccount) throw new Error('Connect a Moonlight account in Dusk Wallet first.');
      saveDraft(vault.id, solverAccount, draft);

      const {prepared} = await prepareCommitSolution(state.dusk, {
        vaultId: vault.id,
        solverAccount,
        plaintextAnswer: draft.answer,
        salt: draft.salt,
      });
      await signAndSubmit(prepared, `Commit solution to Vault #${vault.id}`);
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });

  const revealForm = document.getElementById('revealForm');
  revealForm?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const prepared = await prepareRevealSolution(state.dusk, {
        vaultId: vault.id,
        plaintextAnswer: draft.answer,
        salt: draft.salt,
        discloseWinner: draft.disclose,
        alias: draft.alias,
      });
      await signAndSubmit(prepared, `Reveal solution & claim Vault #${vault.id}`);
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });
}

function renderLeaderboard() {
  const listEl = document.getElementById('leaderboardList');
  if (!listEl) return;

  if (state.leaderboard.length === 0) {
    listEl.innerHTML = `<div class="bot-item">No vaults cracked yet.</div>`;
    return;
  }

  listEl.innerHTML = state.leaderboard
    .map(entry => {
      const pillClass = entry.disclosed ? 'public' : 'anon';
      const pillText = entry.disclosed ? 'PUBLIC' : 'SHADOW';
      const keyLine = entry.disclosed && entry.solverKey
        ? `Key: ${shortKey(entry.solverKey)}`
        : `Key: null (Undisclosed on-chain)`;

      return `
        <div class="leader-row">
          <div class="leader-left">
            <span class="rank-num">${entry.rank}</span>
            <div>
              <div class="leader-name">
                <span>${escapeHtml(entry.displayName)}</span>
                <span class="privacy-pill ${pillClass}">${pillText}</span>
              </div>
              <div class="leader-key">${escapeHtml(keyLine)}</div>
            </div>
          </div>
          <div class="leader-right">
            <div class="leader-bounty">${escapeHtml(entry.bountyDusk)} DUSK</div>
            <div class="leader-cracks">${entry.cracks} vault${entry.cracks === 1 ? '' : 's'} · Blk #${entry.lastCrackAt}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function buildOnChainActivityItems() {
  const items = [];
  const sortedVaults = [...state.vaults].sort((a, b) => b.id - a.id);

  for (const v of sortedVaults) {
    if (v.status === STATUS_CRACKED) {
      items.push({
        fnName: 'reveal_solution',
        status: 'on-chain',
        timestamp: `Block #${v.crackedAt}`,
        summary: `Vault #${v.id} "${v.title}" cracked by ${v.winnerLabel || 'Solver'} — ${v.bountyDusk} DUSK paid`,
        txHash: '',
      });
    } else if (v.status === STATUS_RECLAIMED) {
      items.push({
        fnName: 'reclaim_expired',
        status: 'on-chain',
        timestamp: `Block #${v.expiresAt}`,
        summary: `Vault #${v.id} "${v.title}" expired bounty reclaimed by creator`,
        txHash: '',
      });
    }
    items.push({
      fnName: 'create_vault',
      status: 'on-chain',
      timestamp: `Block #${v.createdAt}`,
      summary: `Vault #${v.id} "${v.title}" forged by ${v.creatorShort} (${v.bountyDusk} DUSK bounty)`,
      txHash: '',
    });
  }

  if (state.activeCommit && state.selectedVaultId != null) {
    items.unshift({
      fnName: 'commit_solution',
      status: 'on-chain',
      timestamp: `Block #${state.activeCommit.committedAt}`,
      summary: `Active commitment locked on Vault #${state.selectedVaultId} (0x${state.activeCommit.hashHex.slice(0, 14)}…)`,
      txHash: '',
    });
  }

  return items;
}

function renderTxFeed() {
  const listEl = document.getElementById('txFeedList');
  if (!listEl) return;

  const onChainItems = buildOnChainActivityItems();
  const combined = [...state.txHistory, ...onChainItems].slice(0, 14);

  if (combined.length === 0) {
    const emptyMsg = isWalletConnected()
      ? 'Wallet connected — forge a new vault or commit a solution to record activity.'
      : 'No protocol activity yet. Connect Dusk Wallet to interact with the Aurora contract.';
    listEl.innerHTML = `
      <div class="event-item">
        ${escapeHtml(emptyMsg)}
      </div>
    `;
    return;
  }

  listEl.innerHTML = combined
    .map(item => `
      <div class="event-item">
        <div class="event-top">
          <span class="event-topic">${escapeHtml(item.fnName)} (${escapeHtml(item.status)})</span>
          <span>${escapeHtml(item.timestamp)}</span>
        </div>
        <div style="color: var(--text-secondary);">
          ${escapeHtml(item.summary)}
          ${item.txHash ? `<br/><code>tx: ${escapeHtml(item.txHash.slice(0, 20))}…</code>` : ''}
        </div>
      </div>
    `)
    .join('');
}

let autoReconnecting = false;

async function tryAutoReconnectWallet() {
  if (!state.dusk || autoReconnecting || !shouldAutoConnectWallet()) return;
  const ws = state.dusk.state;
  if (!ws?.installed) return;

  autoReconnecting = true;
  try {
    if (!ws.selectedAddress) {
      await state.dusk.connect();
    }
    if (state.dusk.state?.selectedAddress) {
      await state.dusk.ensureChain({chainId: state.config.chainId}).catch(() => {});
      await refreshWalletBalance();
      if (state.selectedVaultId != null) {
        state.activeCommit = await readSolverCommitment(
          state.dusk,
          state.selectedVaultId,
          state.dusk.state.selectedAddress
        ).catch(() => null);
      }
      await renderWalletHeader();
      await renderVaultInspector();
    }
  } catch {
    // Wallet may be locked or not yet authorized for this origin; remain in read-only mode
  } finally {
    autoReconnecting = false;
  }
}

function initDuskClient() {
  state.unsubscribeWallet?.();
  state.dusk = connectAuroraApp({
    nodeUrl: state.config.nodeUrl,
    contractId: state.config.contractId,
    driverUrl: state.config.driverUrl,
    autoConnect: true,
  });

  let prevAddress = null;
  state.unsubscribeWallet = state.dusk.subscribe(ws => {
    const nextAddress = isWalletConnected() ? (ws?.selectedAddress || null) : null;
    renderWalletHeader();
    if (nextAddress && nextAddress !== prevAddress) {
      prevAddress = nextAddress;
      refreshWalletBalance().then(() => renderWalletHeader());
      if (state.selectedVaultId != null) {
        readSolverCommitment(state.dusk, state.selectedVaultId, nextAddress)
          .then(c => {
            state.activeCommit = c;
            renderVaultInspector();
          })
          .catch(() => {});
      }
    } else if (!nextAddress && ws?.installed && shouldAutoConnectWallet()) {
      tryAutoReconnectWallet();
    }
  });
}

function setupEventListeners() {
  document.getElementById('syncNodeBtn')?.addEventListener('click', async () => {
    await syncFromNode();
    showToast('Synced state from Dusk node', 'ok');
  });

  // Connect / Disconnect Dusk Wallet
  document.getElementById('connectWalletBtn')?.addEventListener('click', async () => {
    try {
      if (isWalletConnected()) {
        setAutoConnectPreference(false);
        await state.dusk.disconnect().catch(() => {});
        state.account = null;
        state.balanceLux = null;
        state.activeCommit = null;
        showToast('Disconnected Dusk Wallet', 'ok');
      } else {
        setAutoConnectPreference(true);
        await state.dusk.connect();
        await state.dusk.ensureChain({chainId: state.config.chainId});
        showToast('Dusk Wallet connected!', 'ok');
      }
      await syncFromNode();
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });

  // Vault filter pills
  document.getElementById('vaultFilters')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.vaultFilter = btn.dataset.filter;
    document.querySelectorAll('#vaultFilters .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.filter === state.vaultFilter);
    });
    renderVaultGallery();
  });

  // Vault selection
  document.getElementById('vaultList')?.addEventListener('click', async e => {
    const card = e.target.closest('[data-vault-id]');
    if (!card) return;
    state.selectedVaultId = Number(card.dataset.vaultId);
    state.activeCommit =
      state.account && state.selectedVaultId != null
        ? await readSolverCommitment(state.dusk, state.selectedVaultId, state.account)
        : null;
    renderVaultGallery();
    await renderVaultInspector();
  });

  // Leaderboard On-Chain Privacy Toggle (`set_disclosure`)
  const handleDisclosure = async disclose => {
    try {
      const alias = document.getElementById('disclosureAliasInput')?.value || '';
      const tx = await prepareSetDisclosure(state.dusk, {disclose, alias});
      await signAndSubmit(
        tx,
        disclose ? 'Publish leaderboard identity' : 'Cloak leaderboard identity as Shadow'
      );
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  };
  document.getElementById('disclosePublicBtn')?.addEventListener('click', () => handleDisclosure(true));
  document.getElementById('discloseAnonBtn')?.addEventListener('click', () => handleDisclosure(false));

  // Create Vault Modal
  const modal = document.getElementById('createVaultModal');
  const openModal = () => modal?.classList.remove('hidden');
  const closeModal = () => modal?.classList.add('hidden');
  document.getElementById('openCreateModalBtn')?.addEventListener('click', openModal);
  document.getElementById('closeCreateModalBtn')?.addEventListener('click', closeModal);
  document.getElementById('cancelCreateModalBtn')?.addEventListener('click', closeModal);

  const createAnsInput = document.getElementById('createAnswerInput');
  const createHashPreview = document.getElementById('createAnswerHashPreview');
  createAnsInput?.addEventListener('input', async () => {
    const raw = createAnsInput.value;
    if (!raw.trim()) {
      createHashPreview.textContent = 'Type an answer above to preview its 32-byte SHA-256 digest…';
      return;
    }
    const digest = await hashAnswer(raw);
    createHashPreview.textContent = `0x${bytesToHex(digest)}`;
  });

  document.getElementById('createVaultForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const title = document.getElementById('createTitleInput').value;
      const category = document.getElementById('createCategoryInput').value;
      const lore = document.getElementById('createLoreInput').value;
      const hint = document.getElementById('createHintInput').value;
      const plaintextAnswer = document.getElementById('createAnswerInput').value;
      const bountyDusk = document.getElementById('createBountyInput').value;
      const durationBlocks = Number(document.getElementById('createDurationInput').value || 0);

      if (plaintextAnswer.trim().length < 4) {
        throw new Error('Use an answer of at least 4 characters so its SHA-256 hash cannot be trivially brute-forced.');
      }

      const bountyLux = parseDuskToLux(bountyDusk);
      const {prepared} = await prepareCreateVault(state.dusk, {
        title,
        lore,
        category,
        hint,
        plaintextAnswer,
        bountyLux,
        durationBlocks,
      });

      closeModal();
      await signAndSubmit(prepared, `Forge Vault "${title}" (${bountyDusk} DUSK)`);
      e.target.reset();
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  });
}

async function boot() {
  loadTxHistory();
  initDuskClient();
  setupEventListeners();
  await state.dusk.ready();
  await tryAutoReconnectWallet();
  await syncFromNode();
}

boot();
