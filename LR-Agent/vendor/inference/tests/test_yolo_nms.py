import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from runners.yolo import run_yolo_detect, run_yolo_obb


def detection(x, y, width, height, score, class_id=0):
    return SimpleNamespace(
        xywh=np.array([[x + width / 2, y + height / 2, width, height]]),
        cls=np.array(class_id),
        conf=np.array(score),
    )


class YoloNmsTests(unittest.TestCase):
    def predict(self, boxes, *, iou=0.5, end2end=True, roi=None, obb=False):
        model = SimpleNamespace(
            names={0: "logo", 1: "other"},
            predictor=SimpleNamespace(model=SimpleNamespace(end2end=end2end)),
            predict=Mock(
                return_value=[SimpleNamespace(
                    boxes=boxes if not obb else None,
                    obb=boxes if obb else None,
                )]
            ),
        )
        request = {
            "imagePath": "test.jpg",
            "model": {
                "checkpointPath": "test.pt",
                "params": {"confThreshold": 0.35, "iouThreshold": iou, "device": "cpu"},
            },
        }
        if roi:
            request["box"] = roi
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        with (
            patch("runners.yolo.get_yolo_model", return_value=model),
            patch("runners.yolo._load_image", return_value=(image, 200, 100)),
        ):
            result = (run_yolo_obb if obb else run_yolo_detect)(request)
        self.assertEqual(model.predict.call_args.kwargs["conf"], 0.35)
        self.assertEqual(model.predict.call_args.kwargs["iou"], iou)
        return result

    def test_overlapping_same_class_keeps_higher_score(self):
        result = self.predict([
            detection(20, 20, 60, 30, 0.36),
            detection(21, 21, 60, 30, 0.85),
        ])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["confidence"], 0.85)
        self.assertEqual(result["items"][0]["className"], "logo")

    def test_separate_same_class_targets_are_preserved(self):
        result = self.predict([
            detection(10, 10, 30, 20, 0.85),
            detection(100, 10, 30, 20, 0.7),
        ])
        self.assertEqual(len(result["items"]), 2)

    def test_different_classes_do_not_suppress_each_other(self):
        result = self.predict([
            detection(20, 20, 60, 30, 0.85, class_id=0),
            detection(20, 20, 60, 30, 0.7, class_id=1),
        ])
        self.assertEqual([item["classId"] for item in result["items"]], [0, 1])

    def test_configured_iou_threshold_controls_suppression(self):
        boxes = [
            detection(20, 20, 60, 30, 0.85),
            detection(30, 20, 60, 30, 0.7),
        ]
        self.assertEqual(len(self.predict(boxes, iou=0.5)["items"]), 1)
        self.assertEqual(len(self.predict(boxes, iou=0.9)["items"]), 2)

    def test_only_kept_boxes_suppress_later_candidates(self):
        result = self.predict([
            detection(0, 20, 100, 30, 0.9),
            detection(30, 20, 100, 30, 0.8),
            detection(60, 20, 100, 30, 0.7),
        ])
        self.assertEqual([item["confidence"] for item in result["items"]], [0.9, 0.7])

    def test_non_end2end_models_keep_the_existing_postprocessing(self):
        result = self.predict([
            detection(20, 20, 60, 30, 0.85),
            detection(20, 20, 60, 30, 0.7),
        ], end2end=False)
        self.assertEqual(len(result["items"]), 2)

    def test_rotated_boxes_do_not_use_axis_aligned_suppression(self):
        boxes = [
            SimpleNamespace(
                xywhr=np.array([[50, 30, 60, 20, angle]]),
                cls=np.array(0),
                conf=np.array(score),
            )
            for angle, score in [(0.0, 0.85), (1.0, 0.7)]
        ]
        result = self.predict(boxes, obb=True)
        self.assertEqual(len(result["items"]), 2)
        self.assertIn("angle", result["items"][0]["geometry"])

    def test_roi_coordinates_are_preserved(self):
        result = self.predict(
            [detection(35, 25, 30, 10, 0.85), detection(35, 25, 30, 10, 0.7)],
            roi={"x1": 0.25, "y1": 0.2, "x2": 0.75, "y2": 0.8},
        )
        self.assertEqual(len(result["items"]), 1)
        geometry = result["items"][0]["geometry"]
        self.assertAlmostEqual(geometry["x"], 0.425)
        self.assertAlmostEqual(geometry["y"], 0.45)
        self.assertAlmostEqual(geometry["width"], 0.15)
        self.assertAlmostEqual(geometry["height"], 0.1)

    def test_empty_predictions_return_empty_items(self):
        result = self.predict([])
        self.assertEqual(result, {"items": [], "classNames": ["logo", "other"]})

    def test_remaining_boxes_keep_the_original_output_order(self):
        result = self.predict([
            detection(10, 10, 20, 20, 0.6),
            detection(100, 10, 20, 20, 0.9),
        ])
        self.assertEqual([item["confidence"] for item in result["items"]], [0.6, 0.9])


if __name__ == "__main__":
    unittest.main()
