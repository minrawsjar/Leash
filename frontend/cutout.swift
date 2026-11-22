// Rebuilds the hero layers from the source art (macOS only: Vision subject lifting + CoreImage).
//   swift frontend/cutout.swift ~/Downloads/dog.png /tmp/out
//   cwebp -q 82 /tmp/out/bg.jpg -o frontend/src/assets/scene.webp
//   cwebp -q 86 -alpha_q 90 /tmp/out/dog.png -o frontend/src/assets/dog.webp
// The whisker disc centre (885, 455) is specific to this artwork.
import Vision
import CoreImage
import AppKit
import UniformTypeIdentifiers

// usage: plate <src.png> <outdir>  -> bg.jpg (dog removed), dog.png (dog cutout, same canvas size)
let a = CommandLine.arguments
let ci = CIImage(contentsOf: URL(fileURLWithPath: a[1]))!
let out = URL(fileURLWithPath: a[2])
let ext = ci.extent, ctx = CIContext()

let handler = VNImageRequestHandler(ciImage: ci)
let req = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([req])
let obs = req.results!.first!
let mask = CIImage(cvPixelBuffer: try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler))

// Dilate so the fur halo is removed from the plate too.
// Plus a disc over the muzzle so stray whiskers outside Vision's mask don't stay behind.
let whiskers = CIFilter(name: "CIRadialGradient", parameters: ["inputCenter": CIVector(x: 885, y: ext.height - 455),
    "inputRadius0": 70, "inputRadius1": 80, "inputColor0": CIColor.white, "inputColor1": CIColor.black])!.outputImage!.cropped(to: ext)
let hole = mask.clampedToExtent().applyingFilter("CIMorphologyMaximum", parameters: ["inputRadius": 10]).cropped(to: ext)
    .applyingFilter("CIMaximumCompositing", parameters: [kCIInputBackgroundImageKey: whiskers])

// Normalized convolution: premultiply by "keep", blur, composite small radii over large.
let known = CIImage.empty().applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: ci, kCIInputMaskImageKey: hole])
func blur(_ r: Double) -> CIImage { known.clampedToExtent().applyingGaussianBlur(sigma: r).cropped(to: ext) }
// Base = the room's average colour; no division by tiny weights deep inside the hole.
let avg = known.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: ext)])
var fill = avg.unpremultiplyingAlpha().settingAlphaOne(in: avg.extent).clampedToExtent().cropped(to: ext)
for r in [200.0, 100, 50, 24, 10, 4] { fill = blur(r).composited(over: fill) }
let plate = fill.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: ci, kCIInputMaskImageKey: hole])

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
try ctx.writeJPEGRepresentation(of: plate, to: out.appendingPathComponent("bg.jpg"), colorSpace: cs,
    options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.82])
let dog = ci.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: mask])
try ctx.writePNGRepresentation(of: dog, to: out.appendingPathComponent("dog.png"), format: .RGBA8, colorSpace: cs)
print("ok")
