import Foundation
import AppKit
import PDFKit
import Vision
import CoreGraphics

func documentImage(_ image: NSImage) throws -> CGImage {
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { throw HelperError(message: "Could not decode image") }
    return cg
}

func recognizeText(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func readDocument(path: String, startPage: Int, maxPages: Int) throws -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    if url.pathExtension.lowercased() == "pdf" {
        guard let doc = PDFDocument(url: url), !doc.isLocked else { throw HelperError(message: "PDF unreadable or locked") }
        guard startPage >= 1 && startPage <= doc.pageCount else { throw HelperError(message: "Page number is outside the document") }
        var pages: [[String: Any]] = []
        var chars = 0
        for index in (startPage - 1)..<min(doc.pageCount, startPage - 1 + maxPages) {
            guard let page = doc.page(at: index) else { continue }
            var text = page.string ?? ""
            let ocr = text.trimmingCharacters(in: .whitespacesAndNewlines).count < 12
            if ocr { text = try recognizeText(documentImage(page.thumbnail(of: NSSize(width: 1600, height: 2000), for: .mediaBox))) }
            text = String(text.prefix(20000))
            pages.append(["page": index + 1, "text": text, "ocr": ocr])
            chars += text.count
            if chars >= 60000 { break }
        }
        return ["pages": pages, "pageCount": doc.pageCount, "truncated": startPage - 1 + pages.count < doc.pageCount]
    }
    guard let image = NSImage(contentsOf: url) else { throw HelperError(message: "Unsupported image") }
    return ["pages": [["page": 1, "text": String(try recognizeText(documentImage(image)).prefix(60000)), "ocr": true]], "pageCount": 1, "truncated": false]
}

func scaledImage(_ image: CGImage, edge: Int) throws -> CGImage {
    let scale = min(1.0, Double(edge) / Double(max(image.width, image.height)))
    let width = max(1, Int(Double(image.width) * scale)), height = max(1, Int(Double(image.height) * scale))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw HelperError(message: "Could not resize image") }
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let result = context.makeImage() else { throw HelperError(message: "Could not resize image") }
    return result
}

/** Output is a new copy. PDF reduction rasterizes pages, so searchable originals are preserved. */
func prepareDocument(path: String, output: String, format: String, edge: Int, maxBytes: Int) throws -> [String: Any] {
    let input = URL(fileURLWithPath: path)
    let pdf = input.pathExtension.lowercased() == "pdf" ? PDFDocument(url: input) : nil
    if input.pathExtension.lowercased() == "pdf" && (pdf == nil || pdf!.isLocked) { throw HelperError(message: "PDF unreadable or locked") }
    if let pdf = pdf, pdf.pageCount > 80 { throw HelperError(message: "Prepare at most 80 PDF pages at a time") }
    if pdf != nil && format != "pdf" { throw HelperError(message: "Choose PDF output for a PDF source") }
    let count = pdf?.pageCount ?? 1
    guard count > 0 else { throw HelperError(message: "Empty document") }
    // Bound decoded pixels across a batch of PDF pages, even at the largest requested edge.
    let effectiveEdge = min(edge, max(480, Int(sqrt(24_000_000.0 / Double(count)))))
    var images: [CGImage] = []
    for index in 0..<count {
        let image: NSImage?
        if let pdf = pdf { image = pdf.page(at: index)?.thumbnail(of: NSSize(width: effectiveEdge, height: effectiveEdge), for: .mediaBox) }
        else { image = NSImage(contentsOf: input) }
        guard let image = image else { throw HelperError(message: "Unsupported source file") }
        images.append(try scaledImage(documentImage(image), edge: effectiveEdge))
    }
    var result: Data?
    for attempt in 0..<7 {
        let attemptEdge = max(480, Int(Double(effectiveEdge) * pow(0.8, Double(attempt))))
        let quality = max(0.3, 0.85 - Double(attempt) * 0.08)
        if format == "pdf" {
            let doc = PDFDocument()
            for (index, original) in images.enumerated() {
                let cg = try scaledImage(original, edge: attemptEdge)
                let rep = NSBitmapImageRep(cgImage: cg)
                guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]), let decoded = NSImage(data: jpeg), let page = PDFPage(image: decoded) else { throw HelperError(message: "Could not create PDF") }
                doc.insert(page, at: index)
            }
            result = doc.dataRepresentation()
        } else {
            let rep = NSBitmapImageRep(cgImage: try scaledImage(images[0], edge: attemptEdge))
            result = rep.representation(using: format == "png" ? .png : .jpeg, properties: [.compressionFactor: quality])
        }
        if let data = result, maxBytes == 0 || data.count <= maxBytes { break }
    }
    guard let data = result, maxBytes == 0 || data.count <= maxBytes else { throw HelperError(message: "Could not meet this size limit. Try a larger limit or fewer pages.") }
    try data.write(to: URL(fileURLWithPath: output), options: .withoutOverwriting)
    return ["bytes": data.count, "pages": count, "rasterized": pdf != nil, "path": output]
}
