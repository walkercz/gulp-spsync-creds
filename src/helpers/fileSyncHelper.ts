import * as sprequest from 'sp-request';
import * as Promise from 'bluebird';
import * as gutil from 'gulp-util';
import * as path from 'path';
import * as moment from 'moment';

import {IFileInfo} from './../utils/IFileInfo';
import {ISettings, IDigest} from './../utils/ISettings';

import {defer, IDeferred} from './defer';
import {FolderCreator} from './FolderCreator';

import * as fileHelper from './fileHelper';
let fileHlp = new fileHelper.FileHelper();
let digestVal: IDigest = {
	digest: null,
	retrieved: null
}

export class FileSync {
    config: ISettings;
    spr: sprequest.ISPRequest;
	folderCreator: FolderCreator;
	fileInfo: IFileInfo;
	started: moment.Moment;

    constructor(options: ISettings) {
        this.config = options;
        this.spr = sprequest.create({ username: options.username, password: options.password });
    }

	/*
	 * Initialize file upload
	 */
    public init(): Promise<any> {
		this.started = moment();
		return new Promise<any>((resolve, reject) => {
			if (!this.CheckDigestLifespan()) {
				this.spr.requestDigest(this.config.site).then(result => {
					// Store digest
					digestVal.digest = result;
					digestVal.retrieved = moment();
					if (this.config.verbose) {
						gutil.log('INFO: New digest received');
					}
					this.start().then(() => {
						resolve(null);
					});
				});
			} else {
				if (this.config.verbose) {
					gutil.log('INFO: Use cached digest value');
				}
				this.start().then(() => {
					resolve(null);
				});
			}
		});
    }

	/*
	 * Check the lifespan of the digest value
	 */
	CheckDigestLifespan(): boolean {
		if (digestVal.digest !== null && digestVal.retrieved !== null) {
			let now = moment();
			// Use the cached digest value (expires by default after 30 minutes)
			if (now.diff(digestVal.retrieved, 'minutes') < 25) {
				return true;
			}
		}
		return false;
	}

	/*
	 * Start uploading a file
	 */
	private start(): Promise<any> {
		// Get the file info
		this.fileInfo = fileHlp.getFileContext(this.config);
		this.folderCreator = new FolderCreator(this.config, this.spr, digestVal.digest, this.fileInfo);
		return new Promise<any>((resolve, reject) => {
			// Create the required folders
			this.folderCreator.checkFoldersAndCreateIfNotExist()
				.then(() => {
					// Ready to upload file
					return this.upload();
				})
				.then(() => {
					this.started = moment();
					// Ready to set metadata to file
					return this.updateFileMetadata();
				})
				.then(() => {
					this.started = moment();
					// Ready to publish file
					return this.publishFile();
				})
				.then(() => {
					// Everything done
					resolve(null);
				})
				.catch((err) => {
					reject(err);
				}
			);
		});
	}

	/*
	 * Upload file
	 */
	private upload(): Promise<any> {
		let headers = {
			"headers":{
				"X-RequestDigest": digestVal.digest
			},
			"body": this.config.content,
			"json": false
		};

		return new Promise<any>((resolve, reject) => {
			this.spr.post(
					this.config.site + "/_api/web/GetFolderByServerRelativeUrl('" + this.fileInfo.library +"')/Files/add(url='" + this.fileInfo.filename + "',overwrite=true)",
					headers
				)
				.then(success => {
					gutil.log(gutil.colors.green('Upload successful'), gutil.colors.magenta(moment().diff(this.started, 'milliseconds').toString() + 'ms'));
					resolve(success);
				})
				.catch(err => {
					gutil.log(gutil.colors.red("Unable to upload file, it might be checked out to someone"));
					reject(err);
				});
		});
	}

	/*
	 * Update file metadata
	 */
	private updateFileMetadata(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			// Check if the file metadata has to be updated
			if (this.config.update_metadata) {
				// Check if the config consists file metadata
				if (this.config.files_metadata.length <= 0) {
					resolve(null);
				}
				// Check if file metadata exists for the current file
				let fileMetadata = this.config.files_metadata.filter(fm => {
					if (fm.name.toLowerCase() === this.fileInfo.filename.toLowerCase()) {
						return fm;
					}
				});
				if (fileMetadata.length > 0) {
					// Get the first metadata config for of the current file
					let metadata = fileMetadata[0].metadata;
					let header = {
						headers:{
							"content-type":"application/json;odata=verbose",
							"Accept":"application/json;odata=verbose",
							"X-HTTP-Method": "MERGE",
							"If-Match": "*",
							"X-RequestDigest": digestVal.digest
						},
						body: metadata
					};
					this.spr.post(
						this.config.site + "/_api/web/GetFolderByServerRelativeUrl('" + this.fileInfo.library + "')/Files('" + this.fileInfo.filename + "')/listitemallfields",
						header
					).then(postData => {
						gutil.log(gutil.colors.green('Metadata updated successfully'), gutil.colors.magenta(moment().diff(this.started, 'milliseconds').toString() + 'ms'));
						resolve(postData);
					}).catch(err => {
						gutil.log(gutil.colors.red("Unable to update metadata of the file"));
						reject(err);
					});
				} else {
					// Nothing to do, no metadata for the file
					resolve(null);
				}
			} else {
				// Metadata must not be set
				resolve(null);
			}
		});
    }

	/*
	 * Publish the file
	 */
	publishFile(): Promise<any> {
		let deferred = defer();
		// Check if the file needs to be published
		if (this.config.publish) {
			// First check out the file
			return this.checkout().then(() => {
				// Major checkin file
				return this.checkin(deferred, 1);
			}).catch(err => {
				gutil.log(gutil.colors.red("Unable to publish file"));
				deferred.reject(err);
			});
		} else {
			// File must not be published
			deferred.resolve(null);
		}

		return deferred.promise;
	}

	/*
	 * Check out file
	 */
	checkout(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			let header = {
				"headers":{
					"content-type":"application/json;odata=verbose",
					"X-RequestDigest": digestVal.digest
				}
			};
			this.spr.post(
					this.config.site + "/_api/web/GetFolderByServerRelativeUrl('" + this.fileInfo.library +"')/Files('" + this.fileInfo.filename + "')/CheckOut()",
					header
				)
				.then(success => {
					resolve(success);
				})
				.catch(err => {
					reject(err);
				}
			);
		});
	}

	/*
	 * Check in file - Minor: 0 - Major: 1 - Overwrite: 2
	 */
	checkin(deferred: IDeferred<any>, type?: number): Promise<any> {
		// Check if there was a checkin type specified
		if (!type) {
			// MinorCheckIn = 0
			type = 0;
		}
		let header = {
			"headers":{
				"content-type":"application/json;odata=verbose",
				"X-RequestDigest": digestVal.digest
			}
		};
		this.spr.post(
				this.config.site + "/_api/web/GetFolderByServerRelativeUrl('" + this.fileInfo.library +"')/Files('" + this.fileInfo.filename + "')/CheckIn(comment='Checked in via GULP', checkintype=" + type + ")",
				header
			).then(result => {
				gutil.log(gutil.colors.green('Published file'), gutil.colors.magenta(moment().diff(this.started, 'milliseconds').toString() + 'ms'));
				deferred.resolve(result);
			}
		);

		return deferred.promise;
	}
}