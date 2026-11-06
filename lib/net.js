/**
 * 网卡信息。单独成文件，避免 index.js 与 rpc.js 互相 import。
 */
import { networkInterfaces } from 'node:os';

/**
 * 列出可用的局域网 IPv4 地址（不含回环）。
 * @returns {string[]}
 */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}
