// The worker thread that parses a Rekordbox export (`parseExportInWorker`): what the
// parse costs in time and memory stays here, away from the main process.
import { parentPort, workerData } from 'worker_threads'
import { parseRekordboxBytes } from './rekordbox-xml-read'

parentPort?.postMessage(parseRekordboxBytes(workerData as Uint8Array))
