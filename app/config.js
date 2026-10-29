// Immutable deployment configuration for the Aurora dApp.
// Set ACTIVE_NETWORK and DEFAULT_CONTRACT_ID here before deploying the frontend.
// Users cannot override the network, node URL, or contract ID at runtime.

export const NETWORK_PRESETS = Object.freeze({
  testnet: Object.freeze({
    id: 'testnet',
    label: 'Dusk Testnet',
    chainId: 'dusk:2',
    nodeUrl: 'https://testnet.nodes.dusk.network',
  }),
  mainnet: Object.freeze({
    id: 'mainnet',
    label: 'Dusk Mainnet',
    chainId: 'dusk:1',
    nodeUrl: 'https://nodes.dusk.network',
  }),
  local: Object.freeze({
    id: 'local',
    label: 'Local Rusk Node',
    chainId: 'dusk:0',
    nodeUrl: 'http://localhost:8080',
  }),
});

// 1. Choose the target network for this deployment ('testnet' | 'mainnet' | 'local'):
export const ACTIVE_NETWORK = 'testnet';

// 2. Paste your deployed 32-byte (64 hex chars) Aurora ContractId on DuskVM:
export const DEFAULT_CONTRACT_ID =
  '763f34f8157a2428442ef087a404421cd205180bca6f54963fa3c45f98915bf1';

export const DRIVER_URL = new URL('./vendor/aurora-driver.wasm', import.meta.url).href;

const selectedPreset = NETWORK_PRESETS[ACTIVE_NETWORK] || NETWORK_PRESETS.testnet;

export const APP_CONFIG = Object.freeze({
  network: selectedPreset.id,
  networkLabel: selectedPreset.label,
  chainId: selectedPreset.chainId,
  nodeUrl: selectedPreset.nodeUrl,
  contractId: DEFAULT_CONTRACT_ID.trim().replace(/^0x/i, ''),
  driverUrl: DRIVER_URL,
});
