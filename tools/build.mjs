// Compiles the Aurora smart contract WASM, data-driver WASM, TransferMock WASM,
// and deterministic Moonlight keeper keys into `app/vendor/`.
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DIR = join(ROOT, 'contract');
const VM_DIR = join(ROOT, 'vm-test');
const VENDOR_DIR = join(ROOT, 'app', 'vendor');

mkdirSync(VENDOR_DIR, {recursive: true});

console.log('1/4 Building dusk-aurora.wasm (contract)...');
const targetContract = join(CONTRACT_DIR, 'target', 'wasm-contract');
execFileSync('cargo', [
  '+stable', 'build', '--release',
  '--manifest-path', join(CONTRACT_DIR, 'Cargo.toml'),
  '--target', 'wasm32-unknown-unknown',
  '--target-dir', targetContract,
  '--features', 'contract',
], {stdio: 'inherit'});
copyFileSync(
  join(targetContract, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm'),
  join(VENDOR_DIR, 'dusk-aurora.wasm')
);

console.log('2/4 Building aurora-driver.wasm (data-driver-js)...');
const targetDriver = join(CONTRACT_DIR, 'target', 'wasm-driver');
execFileSync('cargo', [
  '+stable', 'build', '--release',
  '--manifest-path', join(CONTRACT_DIR, 'Cargo.toml'),
  '--target', 'wasm32-unknown-unknown',
  '--target-dir', targetDriver,
  '--features', 'data-driver-js',
], {stdio: 'inherit'});
copyFileSync(
  join(targetDriver, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm'),
  join(VENDOR_DIR, 'aurora-driver.wasm')
);

console.log('3/4 Building transfer-mock.wasm + transfer-driver.wasm...');
const mockCrate = join(VM_DIR, 'target', 'mock-crate');
mkdirSync(join(mockCrate, 'src'), {recursive: true});
copyFileSync(join(CONTRACT_DIR, 'Cargo.toml'), join(mockCrate, 'Cargo.toml'));
copyFileSync(join(CONTRACT_DIR, 'Cargo.lock'), join(mockCrate, 'Cargo.lock'));
copyFileSync(join(CONTRACT_DIR, 'build.rs'), join(mockCrate, 'build.rs'));
copyFileSync(join(VM_DIR, 'transfer_mock.rs'), join(mockCrate, 'src', 'lib.rs'));

const mockTargetContract = join(VM_DIR, 'target', 'mock-wasm-contract');
const mockTargetDriver = join(VM_DIR, 'target', 'mock-wasm-driver');
execFileSync('cargo', [
  '+stable', 'build', '--release',
  '--manifest-path', join(mockCrate, 'Cargo.toml'),
  '--target', 'wasm32-unknown-unknown',
  '--target-dir', mockTargetContract,
  '--features', 'contract',
], {stdio: 'inherit'});
execFileSync('cargo', [
  '+stable', 'build', '--release',
  '--manifest-path', join(mockCrate, 'Cargo.toml'),
  '--target', 'wasm32-unknown-unknown',
  '--target-dir', mockTargetDriver,
  '--features', 'data-driver-js',
], {stdio: 'inherit'});
copyFileSync(
  join(mockTargetContract, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm'),
  join(VENDOR_DIR, 'transfer-mock.wasm')
);
copyFileSync(
  join(mockTargetDriver, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm'),
  join(VENDOR_DIR, 'transfer-driver.wasm')
);

console.log('4/4 Generating deterministic Moonlight keeper keys...');
execFileSync('cargo', [
  '+stable', 'build', '--release',
  '--manifest-path', join(VM_DIR, 'Cargo.toml'),
], {stdio: 'inherit'});
const exe = process.platform === 'win32' ? 'aurora-keygen.exe' : 'aurora-keygen';
const keygenOut = JSON.parse(execFileSync(join(VM_DIR, 'target', 'release', exe), [], {encoding: 'utf8'}));
writeFileSync(join(VENDOR_DIR, 'aurora-keepers.json'), JSON.stringify(keygenOut, null, 2) + '\n');

console.log('\nBuild complete! Assets written to app/vendor/');
