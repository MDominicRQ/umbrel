import os from 'node:os'
import {statfs} from 'node:fs/promises'

import type Umbreld from '../../index.js'

// Re-export everything from the flat system module (Docker-compatible implementations)
export {
	getCpuTemperature,
	getSystemDiskUsage,
	getDiskUsage,
	getSystemMemoryUsage,
	getMemoryUsage,
	getCpuUsage,
	reboot,
	shutdown,
	detectDevice,
	isRaspberryPi,
	isUmbrelOS,
	getIpAddresses,
	hasWifi,
	getWifiNetworks,
	connectToWiFiNetwork,
	deleteWifiConnections,
	syncDns,
	commitOsPartition,
} from '../system.js'

// Docker-safe stub: CPU governor not available in containers
export async function setupPiCpuGovernor(_umbreld: Umbreld): Promise<void> {
	return
}

// Docker-safe stub: hostname changes not persisted in containers
export async function restoreHostname(_umbreld: Umbreld): Promise<void> {
	return
}

// Docker-safe stub: WiFi not available in Docker containers
export async function restoreWiFi(_umbreld: Umbreld): Promise<void> {
	return
}

// Docker-safe stub: static IP not applicable in containers
export async function restoreStaticIp(_umbreld: Umbreld): Promise<void> {
	return
}

// Docker-safe stub: system time is synced by the host, no need to wait
export async function waitForSystemTime(_umbreld: Umbreld, _seconds: number): Promise<boolean> {
	return true
}

// Docker-safe: return the container hostname
export async function getHostname(): Promise<string> {
	return os.hostname()
}

// Docker-safe stub: hostname changes not supported in containers
export async function setHostname(_umbreld: Umbreld, _hostname: string): Promise<boolean> {
	return true
}

// Docker-safe stub: return empty network interfaces list (no network config in containers)
export async function getNetworkInterfaces(_umbreld: Umbreld): Promise<[]> {
	return []
}

// Docker-safe stub: static IP not supported in containers
export async function setStaticIp(_umbreld: Umbreld, _input: any): Promise<boolean> {
	return true
}

// Docker-safe stub: static IP confirmation not needed in containers
export async function confirmStaticIp(_ip: string): Promise<boolean> {
	return true
}

// Docker-safe stub: clearing static IP not supported in containers
export async function clearStaticIp(_umbreld: Umbreld, _input: any): Promise<boolean> {
	return true
}

// Return available disk space for the filesystem containing the given path
export async function getDiskUsageByPath(path: string): Promise<{available: number; size: number; used: number}> {
	const stats = await statfs(path)
	const size = stats.blocks * stats.bsize
	const available = stats.bavail * stats.bsize
	const used = size - stats.bfree * stats.bsize
	return {size, used, available}
}
