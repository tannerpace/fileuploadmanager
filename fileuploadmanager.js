var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value)
          })
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value))
        } catch (e) {
          reject(e)
        }
      }
      function rejected(value) {
        try {
          step(generator["throw"](value))
        } catch (e) {
          reject(e)
        }
      }
      function step(result) {
        result.done
          ? resolve(result.value)
          : adopt(result.value).then(fulfilled, rejected)
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next())
    })
  }
import * as path from "path-browserify"
import * as Url from "url"
import retry from "./retry"
import * as BluebirdPromise from "bluebird"
const METRIC_FILE_UPLOAD = "/FileUploadMetrics"
const METRIC_FILE_PART_UPLOAD = "/FilePartUploadMetrics"
export default class FileUploadManager {
  constructor(axios, file, options) {
    this.fileUploadMetrics = {}
    this.file = file
    this.axios = axios
    this.options = Object.assign(
      {
        partSizeBytes: 5 * 1024 * 1024,
        requestTimeoutMs: 60 * 1000,
        maxRetries: 5,
        retryIntervalMs: 2 * 1000,
        maxParallelRequests: 4,
      },
      options
    )
    this.etags = []
    return this
  }
  onUploadCompleted() {
    this.uploadIsInProgress = false
    this.log("Upload completed")
    this.options.onUploadCompleted({
      file: this.file,
      filePath: path.join("_upload", this.getRelativeFilePath(this.file.name)),
    })
  }
  onUploadFailed(errorThrown) {
    this.uploadIsInProgress = false
    this.options.logFunction(
      [
        "Upload failed with server error:",
        errorThrown.message,
        this.file.name,
      ].join(" ")
    )
    this.options.onUploadFailed(errorThrown)
  }
  getRelativeFilePath(fileName) {
    return path.join(
      this.options.customerId,
      this.options.siteId,
      this.options.uploadPath,
      fileName
    )
  }
  fetchJwtToken() {
    return __awaiter(this, void 0, void 0, function* () {
      return yield this.options.getJwtToken()
    })
  }
  log(msg) {
    this.options.logFunction(`[${this.file.name}] ${msg}`)
  }
  retry(asyncCallback) {
    return __awaiter(this, void 0, void 0, function* () {
      let retriesNumber = 0
      const result = yield retry(
        () => {
          retriesNumber++
          return asyncCallback()
        },
        this.options.retryIntervalMs,
        this.options.maxRetries
      )
      return { result, retriesNumber }
    })
  }
  startUpload() {
    if (this.uploadIsInProgress) {
      return
    }
    ;(() =>
      __awaiter(this, void 0, void 0, function* () {
        try {
          this.uploadIsInProgress = true
          const fileUploadStartTime = Date.now()
          if (this.file.size > this.options.partSizeBytes) {
            yield this.uploadMultipartFile()
          } else {
            yield this.uploadSimpleFile()
          }
          const fileUploadTimeSeconds =
            (Date.now() - fileUploadStartTime) / 1000
          this.fileUploadMetrics.uploadTimeSec = fileUploadTimeSeconds
          this.fileUploadMetrics.sizeMb = this.file.size / 1e6
          this.fileUploadMetrics.uploadSpeedMBitsPerSec =
            (this.fileUploadMetrics.sizeMb * 8) / fileUploadTimeSeconds
          this.options.metricFunction(
            METRIC_FILE_UPLOAD,
            this.fileUploadMetrics
          )
          this.onUploadCompleted()
        } catch (err) {
          this.onUploadFailed(err)
        }
      }))()
  }
  uploadMultipartFile() {
    return __awaiter(this, void 0, void 0, function* () {
      const endpoint = Url.resolve(
        this.options.bspHost,
        path.join("upload", this.getRelativeFilePath(this.file.name))
      )
      yield this.retry(() =>
        __awaiter(this, void 0, void 0, function* () {
          const uploadId = yield this.initiateMultipartUpload(endpoint)
          yield this.uploadParts(endpoint, uploadId)
          const partsAssembleStartTime = Date.now()
          yield this.completeMultipartUpload(endpoint, uploadId, this.etags)
          this.fileUploadMetrics.assembleSec =
            (Date.now() - partsAssembleStartTime) / 1000
        })
      )
    })
  }
  uploadSimpleFile() {
    return __awaiter(this, void 0, void 0, function* () {
      const blob = this.file.slice(0, this.file.size)
      this.fileUploadMetrics.partsCnt = 1
      const partUploadMetrics = {}
      const endpoint = Url.resolve(
        this.options.bspHost,
        path.join("upload", this.getRelativeFilePath(this.file.name))
      )
      const partUploadStartTime = Date.now()
      const { retriesNumber } = yield this.retry(() =>
        this.uploadWholeFile(endpoint, blob)
      )
      const partUploadTimeSec = (Date.now() - partUploadStartTime) / 1000
      partUploadMetrics.uploadTimeSec = partUploadTimeSec
      partUploadMetrics.sizeMb = blob.size / 1e6
      partUploadMetrics.uploadSpeedMBitsPerSec =
        (partUploadMetrics.sizeMb * 8) / partUploadTimeSec
      partUploadMetrics.retriesCnt = retriesNumber
      this.options.metricFunction(METRIC_FILE_PART_UPLOAD, partUploadMetrics)
    })
  }
  initiateMultipartUpload(endpoint) {
    return __awaiter(this, void 0, void 0, function* () {
      this.log("Initiating multipart upload")
      const jwtToken = yield this.fetchJwtToken()
      return this.axios
        .request({
          method: "POST",
          url: endpoint + "?uploads",
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            "Content-Disposition": "attachment",
          },
          timeout: this.options.requestTimeoutMs,
        })
        .then((res) => {
          // parse response to extract UploadId
          const parser = new DOMParser()
          const xmlDoc = parser.parseFromString(res.data, "text/xml")
          if (!xmlDoc || !xmlDoc.getElementsByTagName("UploadId").length) {
            throw new Error("Could not receive UploadId")
          }
          const uploadId =
            xmlDoc.getElementsByTagName("UploadId")[0].textContent
          if (!uploadId) {
            throw new Error("Failed to get uploadId from xml")
          }
          this.log(`Multipart upload initiated, uploadId is ${uploadId}`)
          return uploadId
        })
        .catch((err) => {
          this.log(`Failed initiating multipart upload: ${err.message}`)
          throw err
        })
    })
  }
  uploadParts(endpoint, uploadId) {
    let start = 0
    let end
    let partNum = 0
    const blobs = []
    while (start < this.file.size) {
      end = Math.min(start + this.options.partSizeBytes, this.file.size)
      const filePart = this.file.slice(start, end)
      // this is to prevent push blob with 0Kb
      if (filePart.size > 0) {
        blobs.push(filePart)
      }
      start = this.options.partSizeBytes * ++partNum
    }
    this.fileUploadMetrics.partsCnt = blobs.length
    return BluebirdPromise.map(
      blobs,
      (blob, index) =>
        __awaiter(this, void 0, void 0, function* () {
          const partUploadMetrics = {}
          const { retriesNumber } = yield this.retry(() =>
            __awaiter(this, void 0, void 0, function* () {
              const partUploadStartTime = Date.now()
              yield this.uploadFilePart(
                endpoint,
                blob,
                uploadId,
                index,
                this.file.type
              )
              const partUploadTimeSec =
                (Date.now() - partUploadStartTime) / 1000
              partUploadMetrics.uploadTimeSec = partUploadTimeSec
              partUploadMetrics.sizeMb = blob.size / 1e6
              partUploadMetrics.uploadSpeedMBitsPerSec =
                (partUploadMetrics.sizeMb * 8) / partUploadTimeSec
            })
          )
          partUploadMetrics.retriesCnt = retriesNumber
          this.options.metricFunction(
            METRIC_FILE_PART_UPLOAD,
            partUploadMetrics
          )
        }),
      {
        concurrency: this.options.maxParallelRequests,
      }
    )
  }
  uploadWholeFile(endpoint, blob) {
    return __awaiter(this, void 0, void 0, function* () {
      this.log(`Sending file as a whole`)
      const jwtToken = yield this.fetchJwtToken()
      return this.axios
        .request({
          method: "PUT",
          url: endpoint,
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            "Content-Disposition": "attachment",
            "Content-Type": this.file.type,
          },
          data: blob,
        })
        .catch((err) => {
          this.log(`File upload failed ${err.message}`)
          throw err
        })
        .then((res) => {
          if (res && res.status === 200) {
            const etag = res.headers.etag || ""
            if (etag) {
              return etag
            }
            // Maybe it makes sense to add error handler to retry fn in order to avoid duplicating
            const errorMsg = "Failed to get ETag"
            this.log(errorMsg)
            throw new Error(errorMsg)
          }
          const errorMsg = "Failed to get ETag"
          this.log(errorMsg)
          throw new Error(errorMsg)
        })
    })
  }
  uploadFilePart(endpoint, blob, uploadId, partNum = 0, fileType) {
    return __awaiter(this, void 0, void 0, function* () {
      this.log(`Sending part ${partNum}`)
      const jwtToken = yield this.fetchJwtToken()
      return this.axios
        .request({
          method: "PUT",
          url: `${endpoint}?partNumber=${partNum + 1}&uploadId=${uploadId}`,
          timeout: this.options.requestTimeoutMs,
          headers: {
            "Content-Type": fileType,
            Authorization: `Bearer ${jwtToken}`,
          },
          data: blob,
        })
        .catch((err) => {
          this.log(`Part upload failed ${err.message}`)
          throw err
        })
        .then((res) => {
          if (!res || res.status !== 200) {
            throw new Error(
              `File upload response is ${res.status}: ${res.data}`
            )
          }
          const etag = res.headers.etag
          if (!etag) {
            throw new Error(`Failed to get ETag`)
          }
          // TODO: don't use class variable for etags
          this.etags[partNum] = etag
          return etag
        })
    })
  }
  completeMultipartUpload(endpoint, uploadId, etags) {
    return __awaiter(this, void 0, void 0, function* () {
      const jwtToken = yield this.fetchJwtToken()
      return this.axios
        .request({
          method: "POST",
          url: `${endpoint}?uploadId=${uploadId}`,
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            "Content-Type": "application/octet-stream; charset=UTF-8",
          },
          data: `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${etags
            .map(
              (tag, partNum) =>
                `<Part><ETag>${tag}</ETag><PartNumber>${
                  partNum + 1
                }</PartNumber></Part>`
            )
            .join("")}</CompleteMultipartUpload>`,
        })
        .then((res) => {
          const getProperty = (xmlString, property) => {
            const parser = new DOMParser()
            const xmlDoc = parser.parseFromString(res.data, "text/xml")
            if (!xmlDoc || !xmlDoc.getElementsByTagName(property).length) {
              throw new Error(
                `Invalid or 200 error response, ${property} not found: ${res.data}`
              )
            }
            const value = xmlDoc.getElementsByTagName(property)[0].textContent
            if (!value) {
              throw new Error(
                `Failed to get ${property} property from xml: ${res.data}`
              )
            }
            return value
          }
          const key = getProperty(res.data, "Key")
          const location = getProperty(res.data, "Location")
          return { key, location }
        })
    })
  }
}
//# sourceMappingURL=FileUploadManager.js.map
