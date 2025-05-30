
# The name of the Samba server that will show in clients.
server string = Umbrel

# Defer to mDNS for discovery instead of advertising uppercase NETBIOS name.
mdns name = mdns

# Use Systemd for logging.
# Samba still tries to log to file, so pipe that to /dev/null.
logging = systemd
log file = /dev/null

# Make sure that we are not leaking information to guests or anonymous users.
access based share enum = yes
restrict anonymous = 2
map to guest = never

# Better compatibility for macOS clients
# https://wiki.samba.org/index.php/Configure_Samba_to_Work_Better_with_Mac_OS_X
vfs objects = catia fruit streams_xattr
fruit:metadata = stream
fruit:model = MacSamba
fruit:veto_appledouble = no
fruit:nfs_aces = no
fruit:wipe_intentionally_left_blank_rfork = yes
fruit:delete_empty_adfiles = yes
fruit:posix_rename = yes

# Disable printing services.
load printers = no
disable spoolss = yes
`

// Indiviudal share config
const shareConfig = (name: string, path: string) => `
# Share specific config
[${name}]
path = ${path}
writeable = yes

# Only allow "umbrel" user to access the share.
valid users = umbrel

# Handle permissions
# We force root so samba can read files that could be created by app processes
# running as various users including root.
# We inherit owner to avoid breaking permissions for apps that expect files in
# their data directories to be owned by them.
force user = root
force group = umbrel
inherit owner = yes

# Enable Time Machine backups.
fruit:time machine = yes
`

export default class Samba {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	#removeFileChangeListener?: () => void

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`files:${name.toLocaleLowerCase()}`)
	}

	// Add listener
	async start() {
		this.logger.log('Starting samba')

		// Make sure the share password exists and is applied
		await this.applySharePassword().catch((error) => {
			this.logger.error(`Failed to apply share password`, error)
		})

		// Apply shares (and start Samba/wsdd2 if needed)
		await this.applyShares().catch((error) => {
			this.logger.error(`Failed to apply shares`, error)
		})

		// Attach listener
		this.#removeFileChangeListener = this.#umbreld.eventBus.on(
			'files:watcher:change',
			this.#handleFileChange.bind(this),
		)
	}

	// Remove listener
	async stop() {
		this.logger.log('Stopping samba')
		this.#removeFileChangeListener?.()
		await $`systemctl stop smbd`.catch((error) => this.logger.error(`Failed to stop samba`, error))
		await $`systemctl stop wsdd2`.catch((error) => this.logger.error(`Failed to stop wsdd2`, error))
	}

	// Gets the share password
	// On first run it will generate a random password and save it to the file.
	// TODO: Some kind of umbreld.secrets.get() api for dealing with this kind
	// of stuff might be nice in the future.
	async getSharePassword() {
		const sharePasswordFile = `${this.#umbreld.dataDirectory}/secrets/share-password`

		// Get or create the share password
		const sharePassword = await fse.readFile(sharePasswordFile, 'utf8').catch(async () => {
			this.logger.log('Creating share password on first run')
			const sharePassword = randomToken(128)
			await fse.writeFile(sharePasswordFile, sharePassword)
			return sharePassword
		})

		return sharePassword
	}

	// Applies the share password to the Samba user
	async applySharePassword() {
		const sharePassword = await this.getSharePassword()
		await $({
			input: `${sharePassword}\n${sharePassword}\n`,
		})`smbpasswd -s -a umbrel`
	}

	// Apply shares to Samba
	async applyShares() {
		const shares = await this.#get()

		// Generate Samba config
		let config = SMB_CONFIG
		for (const share of shares) {
			// Make Umbrel shares easily detectable in clients
			share.name = `${share.name} (Umbrel)`

			// Share /Home as "username's Umbrel"
			if (share.path === '/Home') {
				const user = await this.#umbreld.user.get()
				const username = user?.name
				if (username) share.name = `${username}'s Umbrel`
			}

			// Convert to system path
			share.path = await this.#umbreld.files.virtualToSystemPath(share.path)

			// Append the share config
			config += shareConfig(share.name, share.path)
		}

		// Write out Samba config
		await fse.writeFile('/etc/samba/smb.conf', config)

		// If we don't have any shares, ensure samba isn't running and return
		if (shares.length === 0) return await $`systemctl stop smbd`

		// Otherwise start samba, or reload it's config if it's already running
		await $`systemctl start smbd`
		await $`smbcontrol smbd reload-config`

		// We also start wsdd2 for better Windows discovery.
		// We need to manually start this along with samba because if we boot with wsdd2
		// enabled but without samba it will shutdown when it sees samba isn't running.
		// It won't then auto start if a share is added later.
		await $`systemctl start wsdd2`
	}

	// Read current shares from the store
	async #get() {
		const shares = await this.#umbreld.store.get('files.shares')
		return shares || []
	}

	// Remove shares on deletion
	// TODO: It would be nice if we could handle updating favorites when the favorited directory is
	// moved/renamed. It's not trivial because this can happen via something external like an app or SMB
	// and there's no way to tell the difference between a move/rename and a deletion/recreation.
	async #handleFileChange(event: FileChangeEvent) {
		if (event.type !== 'delete') return
		const shares = await this.#get()
		const virtualDeletedPath = this.#umbreld.files.systemToVirtualPath(event.path)
		const deletedShares = shares.filter((share) => share.path.startsWith(virtualDeletedPath))
		for (const share of deletedShares) await this.removeShare(share.path)
	}

	// List favorited directories
	async listShares() {
		// Get shares from the store
		const shares = await this.#get()

		// Strip out any shares that aren't existing directories
		const mappedShares = await Promise.all(
			shares.map(async (share) => {
				const systemPath = await this.#umbreld.files.virtualToSystemPath(share.path)
				const file = await this.#umbreld.files.status(systemPath).catch(() => undefined)
				if (file?.type !== 'directory') return undefined
				return share
			}),
		)
		const filteredShares = mappedShares.filter((share) => share !== undefined)

		return filteredShares
	}

	// Share a new directory
	async addShare(virtualPath: string) {
		// Check if operation is allowed
		const allowedOperations = await this.#umbreld.files.getAllowedOperations(virtualPath)
		if (!allowedOperations.includes('share')) throw new Error('[operation-not-allowed]')

		// Add share
		this.logger.log(`Adding share for ${virtualPath}`)

		// Aquire write lock on the store
		await this.#umbreld.store.getWriteLock(async ({set}) => {
			// Get current shares
			const shares = await this.#get()

			// Error if share already exists
			const shareExists = shares.some((share) => share.path === virtualPath)
			if (shareExists) throw new Error('[share-already-exists]')

			// Set unique share name
			let name = nodeimport nodePath from 'node:path'

import fse from 'fs-extra'
import {$} from 'execa'

import randomToken from '../utilities/random-token.js'

import type Umbreld from '../../index.js'
import type {FileChangeEvent} from './watcher.js'

// Global Samba config
const SMB_CONFIG = `# Generated by umbreld

[global]
# In standalone operation, a client must first "log-on" with a valid username
# and password stored on this machine.
server role = standalone
Path.basename(virtualPath)
			let i = 1
			while (shares.some((share) => share.name === name)) {
				i++
				if (i > 10) throw new Error('[share-name-generation-failed]')
				name = `${nodePath.basename(virtualPath)} (${i})`
			}

			// Add share to the store
			await set('files.shares', [...shares, {name, path: virtualPath}])
		})

		// Apply changes to Samba
		await this.applyShares()

		// Return virtual path
		return virtualPath
	}

	// Remove a share
	async removeShare(virtualPath: string) {
		this.logger.log(`Removing share for ${virtualPath}`)

		let deleted = false
		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const shares = await this.#get()
			const newShares = shares.filter((share) => share.path !== virtualPath)
			deleted = newShares.length < shares.length
			if (deleted) await set('files.shares', newShares)
		})

		// Apply changes to Samba
		if (deleted) {
			// Note: Clients that are already connected to a removed share will continue to stay
			// connected. This is intentional behaviour by samba to avoid corruption by force disconnecting
			// users while they might be using a share.
			// We can force disconnect with `smbcontrol smbd close-share $share` but it could be dangerous
			// and it doesn't work reliably accross clients. macOS drops the connection immediately. Linux
			// shows the files but errors on any navigation or write. Windows continues to stay connected.
			await this.applyShares()
		}

		// Return deleted boolean
		return deleted
	}
}
