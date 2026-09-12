import cv2

print(cv2.getBuildInformation())  # 查看编译信息，确认 CUDA 支持已启用
print(cv2.cuda.getCudaEnabledDeviceCount())  # 输出可用的 CUDA 设备数量